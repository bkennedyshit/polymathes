#pragma once

#include <iostream>
#include <string>
#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>
#include <spdlog/sinks/stdout_color_sinks.h>

#include "omni/config/config.hpp"
#include "omni/search/embedding_engine.hpp"
#include "omni/search/indexer.hpp"
#include "omni/search/search_engine.hpp"
#include "omni/search/storage.hpp"

namespace omni {
namespace mcp {

using json = nlohmann::json;

// Tool schemas returned by tools/list
static const json TOOLS = json::array({
    {
        {"name", "media_index"},
        {"description", "Index a directory of media files (images, video, audio, docs, code)"},
        {"inputSchema", {
            {"type", "object"},
            {"properties", {
                {"path", {{"type", "string"}, {"description", "Directory path to index"}}},
                {"frame_interval", {{"type", "number"}, {"description", "Seconds between video frames (default 2.0)"}}},
                {"force", {{"type", "boolean"}, {"description", "Re-index already-indexed files"}}},
                {"exclude", {{"type", "string"}, {"description", "Exclude pattern (substring match)"}}}
            }},
            {"required", json::array({"path"})}
        }}
    },
    {
        {"name", "media_search"},
        {"description", "Natural-language semantic search over indexed media"},
        {"inputSchema", {
            {"type", "object"},
            {"properties", {
                {"query", {{"type", "string"}, {"description", "Search query"}}},
                {"top_k", {{"type", "integer"}, {"description", "Max results (default 10)"}}},
                {"min_score", {{"type", "number"}, {"description", "Min similarity score 0-1 (default 0.25)"}}},
                {"type_filter", {{"type", "string"}, {"description", "Filter by type: image, video_segment, audio_segment, document, code"}}}
            }},
            {"required", json::array({"query"})}
        }}
    },
    {
        {"name", "media_search_by_image"},
        {"description", "Reverse image search — find visually similar media"},
        {"inputSchema", {
            {"type", "object"},
            {"properties", {
                {"image_path", {{"type", "string"}, {"description", "Path to query image"}}},
                {"top_k", {{"type", "integer"}, {"description", "Max results (default 10)"}}}
            }},
            {"required", json::array({"image_path"})}
        }}
    },
    {
        {"name", "media_describe"},
        {"description", "Fetch full record for an indexed asset by ID"},
        {"inputSchema", {
            {"type", "object"},
            {"properties", {
                {"id", {{"type", "integer"}, {"description", "Asset ID from search results"}}}
            }},
            {"required", json::array({"id"})}
        }}
    }
});

static json make_response(const json& id, const json& result) {
    return {{"jsonrpc", "2.0"}, {"id", id}, {"result", result}};
}

static json make_error(const json& id, int code, const std::string& msg) {
    return {{"jsonrpc", "2.0"}, {"id", id}, {"error", {{"code", code}, {"message", msg}}}};
}

static void send(const json& obj) {
    std::cout << obj.dump() << "\n";
    std::cout.flush();
}

static json results_to_json(const std::vector<omni::search::SearchResult>& results) {
    json arr = json::array();
    for (const auto& r : results) {
        json item = {{"path", r.path}, {"type", r.type}, {"score", r.score}};
        if (r.timestamp > 0.0) item["timestamp"] = r.timestamp;
        if (!r.metadata_json.empty() && r.metadata_json != "{}") {
            try { item["metadata"] = json::parse(r.metadata_json); } catch (...) {}
        }
        arr.push_back(item);
    }
    return arr;
}

inline void run_mcp_stdio(const omni::config::AppConfig& cfg) {
    // Redirect all logging to stderr so stdout stays clean for JSON-RPC
    spdlog::set_default_logger(spdlog::stderr_color_mt("mcp"));
    spdlog::set_level(spdlog::level::warn);

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;

        json req;
        try {
            req = json::parse(line);
        } catch (const std::exception& e) {
            send(make_error(nullptr, -32700, std::string("Parse error: ") + e.what()));
            continue;
        }

        const json id = req.value("id", json(nullptr));
        const std::string method = req.value("method", "");
        const json params = req.value("params", json::object());

        try {
            if (method == "initialize") {
                send(make_response(id, {
                    {"protocolVersion", "2024-11-05"},
                    {"capabilities", {{"tools", json::object()}}},
                    {"serverInfo", {{"name", "media-memory"}, {"version", "1.0.0"}}}
                }));

            } else if (method == "notifications/initialized") {
                // No response needed for notifications
                continue;

            } else if (method == "tools/list") {
                send(make_response(id, {{"tools", TOOLS}}));

            } else if (method == "tools/call") {
                const std::string tool = params.value("name", "");
                const json args = params.value("arguments", json::object());

                omni::search::EmbeddingEngineConfig eng_cfg;
                eng_cfg.model_dir = cfg.model_dir;
                eng_cfg.clip_model = cfg.clip_model;
                eng_cfg.use_trt = cfg.use_tensorrt;

                if (tool == "media_index") {
                    std::string path = args.at("path").get<std::string>();
                    omni::search::Indexer::Options opts;
                    opts.frame_interval = args.value("frame_interval", cfg.frame_interval);
                    opts.force_reindex = args.value("force", cfg.force_reindex);
                    opts.exclude_pattern = args.value("exclude", cfg.exclude_pattern);
                    opts.chunk_words = cfg.chunk_words;
                    opts.overlap_words = cfg.overlap_words;

                    omni::search::Indexer indexer(cfg.db_path, eng_cfg, opts);
                    indexer.scan_directory(path);

                    send(make_response(id, {{"content", json::array({{{"type", "text"}, {"text", "Indexing complete for: " + path}}})}}));

                } else if (tool == "media_search") {
                    std::string query = args.at("query").get<std::string>();
                    omni::search::SearchEngineOptions sopts;
                    sopts.top_k = args.value("top_k", cfg.top_k);
                    sopts.min_score = args.value("min_score", cfg.min_score);

                    omni::search::SearchEngine engine(cfg.db_path, eng_cfg, sopts);
                    auto results = engine.query(query);

                    // Apply optional type filter
                    if (args.contains("type_filter")) {
                        std::string tf = args["type_filter"].get<std::string>();
                        results.erase(std::remove_if(results.begin(), results.end(),
                            [&](const auto& r){ return r.type != tf; }), results.end());
                    }

                    json out = results_to_json(results);
                    send(make_response(id, {{"content", json::array({{{"type", "text"}, {"text", out.dump()}}})}}));

                } else if (tool == "media_search_by_image") {
                    std::string image_path = args.at("image_path").get<std::string>();
                    omni::search::SearchEngineOptions sopts;
                    sopts.top_k = args.value("top_k", cfg.top_k);
                    sopts.min_score = cfg.min_score;

                    omni::search::SearchEngine engine(cfg.db_path, eng_cfg, sopts);
                    auto results = engine.query_image(image_path);

                    json out = results_to_json(results);
                    send(make_response(id, {{"content", json::array({{{"type", "text"}, {"text", out.dump()}}})}}));

                } else if (tool == "media_describe") {
                    int64_t asset_id = args.at("id").get<int64_t>();
                    omni::search::Storage storage(cfg.db_path);
                    auto record = storage.get_asset_by_id(asset_id);

                    json out = {
                        {"id", record.id},
                        {"path", record.path},
                        {"type", record.type},
                        {"timestamp", record.timestamp}
                    };
                    if (!record.metadata_json.empty() && record.metadata_json != "{}") {
                        try { out["metadata"] = json::parse(record.metadata_json); } catch (...) {}
                    }
                    send(make_response(id, {{"content", json::array({{{"type", "text"}, {"text", out.dump()}}})}}));

                } else {
                    send(make_error(id, -32601, "Unknown tool: " + tool));
                }

            } else {
                send(make_error(id, -32601, "Method not found: " + method));
            }

        } catch (const std::exception& e) {
            send(make_error(id, -32603, std::string("Internal error: ") + e.what()));
        }
    }
}

} // namespace mcp
} // namespace omni
