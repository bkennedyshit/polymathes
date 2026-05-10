#include <iostream>
#include <string>
#include <memory>
#include <spdlog/spdlog.h>
#include <spdlog/sinks/stdout_color_sinks.h>

#include "omni/config/config.hpp"
#include "omni/search/indexer.hpp"
#include "omni/search/search_engine.hpp"
#include "omni/search/embedding_engine.hpp"
#include "omni/chat/chatbot.hpp"
#include "omni/mcp/mcp_server.hpp"

void print_usage(const char* prog_name) {
    std::cout << "========================================\n";
    std::cout << "   Omni-Search: The ChatRTX Killer\n";
    std::cout << "========================================\n\n";
    std::cout << "Usage:\n";
    std::cout << "  " << prog_name << " index <directory>       - Index a directory\n";
    std::cout << "  " << prog_name << " search <query>          - Search by text\n";
    std::cout << "  " << prog_name << " search --image <path>   - Search by image\n";
    std::cout << "  " << prog_name << " chat                    - Interactive RAG chat\n";
    std::cout << "  " << prog_name << " --mcp-stdio             - MCP server mode (JSON-RPC over stdin/stdout)\n";
    std::cout << "\nOptions:\n";
    std::cout << "  --config <path>         - Config file (default: ~/.omni-search/config.json)\n";
    std::cout << "  --db-path <path>        - Database path\n";
    std::cout << "  --model-dir <path>      - Model directory\n";
    std::cout << "  --clip-model <name>     - CLIP model name\n";
    std::cout << "  --llm-model <path>      - LLM model path\n";
    std::cout << "  --log-level <level>     - Log level (debug, info, warn, error)\n";
    std::cout << "  --force-reindex         - Re-index even if already indexed\n";
    std::cout << "  --exclude <pattern>     - Exclude directories matching pattern\n";
    std::cout << "  --top-k <num>           - Number of results (default: 10)\n";
    std::cout << "  --min-score <float>     - Minimum similarity score (default: 0.25)\n";
    std::cout << "  --frame-interval <sec>  - Seconds between video frames (default: 2.0)\n";
    std::cout << "  --max-video-minutes <n> - Skip videos longer than N minutes (default: 10)\n";
    std::cout << "  --max-file-mb <n>       - Skip files larger than N MB (default: 2048)\n";
    std::cout << "  --force-large           - Bypass size/duration guardrails\n";
    std::cout << "                            (WARNING: raw 4K footage indexes slowly and retrieves poorly —\n";
    std::cout << "                             prefer edited reels/shorts/clips)\n";
    std::cout << "  --no-intent             - Skip content intent classification (pin/post/reel/etc)\n";
    std::cout << "  --vlm-tag               - Generate tags with a local vision model (slow; opt-in)\n";
    std::cout << "  --vlm-endpoint <url>    - Vision model API (default: Ollama at localhost:11434)\n";
    std::cout << "  --vlm-model <name>      - Vision model name (default: qwen2.5vl:7b)\n";
    std::cout << std::endl;
}

void init_logging(const std::string& log_level) {
    auto console = spdlog::stdout_color_mt("console");
    spdlog::set_default_logger(console);
    
    // Set log level
    if (log_level == "debug") {
        spdlog::set_level(spdlog::level::debug);
    } else if (log_level == "info") {
        spdlog::set_level(spdlog::level::info);
    } else if (log_level == "warn") {
        spdlog::set_level(spdlog::level::warn);
    } else if (log_level == "error") {
        spdlog::set_level(spdlog::level::err);
    } else {
        spdlog::set_level(spdlog::level::info);
    }
    
    spdlog::set_pattern("[%Y-%m-%d %H:%M:%S] [%^%l%$] %v");
}

int main(int argc, char* argv[]) {
    if (argc < 2) {
        print_usage(argv[0]);
        return 1;
    }
    
    std::string command = argv[1];

    // In MCP stdio mode, redirect all logging to stderr immediately
    // so nothing pollutes the JSON-RPC stdout stream
    bool mcp_mode = (command == "--mcp-stdio");
    if (mcp_mode) {
        spdlog::set_default_logger(spdlog::stderr_color_mt("mcp_early"));
        spdlog::set_level(spdlog::level::warn);
    }
    
    // Load config
    std::string config_path = "~/.omni-search/config.json";
    for (int i = 1; i < argc; ++i) {
        if (std::string(argv[i]) == "--config" && i + 1 < argc) {
            config_path = argv[++i];
        }
    }
    
    auto config = omni::config::load_config(config_path);
    
    // Check if config file exists, create default if not
    std::string expanded_config = omni::config::expand_home(config_path);
    if (!std::filesystem::exists(expanded_config)) {
        omni::config::save_default_config(config_path);
    }
    
    // Parse CLI arguments (override config)
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--db-path" && i + 1 < argc) {
            config.db_path = argv[++i];
        } else if (arg == "--model-dir" && i + 1 < argc) {
            config.model_dir = argv[++i];
        } else if (arg == "--clip-model" && i + 1 < argc) {
            config.clip_model = argv[++i];
        } else if (arg == "--llm-model" && i + 1 < argc) {
            config.llm_model_path = argv[++i];
        } else if (arg == "--log-level" && i + 1 < argc) {
            config.log_level = argv[++i];
        } else if (arg == "--force-reindex") {
            config.force_reindex = true;
        } else if (arg == "--exclude" && i + 1 < argc) {
            config.exclude_pattern = argv[++i];
        } else if (arg == "--top-k" && i + 1 < argc) {
            config.top_k = std::stoi(argv[++i]);
        } else if (arg == "--min-score" && i + 1 < argc) {
            config.min_score = std::stof(argv[++i]);
        } else if (arg == "--frame-interval" && i + 1 < argc) {
            config.frame_interval = std::stod(argv[++i]);
        } else if (arg == "--force-large") {
            config.force_large = true;
        } else if (arg == "--max-video-minutes" && i + 1 < argc) {
            config.max_video_duration_seconds = std::stod(argv[++i]) * 60.0;
        } else if (arg == "--max-file-mb" && i + 1 < argc) {
            config.max_file_size_mb = std::stod(argv[++i]);
        } else if (arg == "--no-intent") {
            config.classify_intent = false;
        } else if (arg == "--vlm-tag") {
            config.use_vlm_tagging = true;
        } else if (arg == "--vlm-endpoint" && i + 1 < argc) {
            config.vlm_endpoint = argv[++i];
        } else if (arg == "--vlm-model" && i + 1 < argc) {
            config.vlm_model = argv[++i];
        }
    }
    
    // Initialize logging (skip in MCP mode — already redirected to stderr above)
    if (!mcp_mode) {
        init_logging(config.log_level);
        spdlog::info("Omni-Search: The ChatRTX Killer");
        spdlog::debug("Config loaded from: {}", config_path);
        spdlog::debug("Database: {}", config.db_path);
        spdlog::debug("Model: {}", config.clip_model);
    }
    
    // Expand paths
    config.db_path = omni::config::expand_home(config.db_path);

    // MCP stdio mode — must check before command dispatch
    if (command == "--mcp-stdio") {
        omni::mcp::run_mcp_stdio(config);
        return 0;
    }

    // Execute command
    try {
        if (command == "index") {
            if (argc < 3) {
                spdlog::error("Usage: {} index <directory>", argv[0]);
                return 1;
            }
            std::string target_dir = argv[2];
            
            spdlog::info("Indexing directory: {}", target_dir);
            
            // Create embedding engine config
            omni::search::EmbeddingEngineConfig eng_cfg;
            eng_cfg.model_dir = config.model_dir;
            eng_cfg.clip_model = config.clip_model;
            eng_cfg.use_trt = config.use_tensorrt;
            
            // Create indexer options
            omni::search::Indexer::Options opts;
            opts.frame_interval = config.frame_interval;
            opts.force_reindex = config.force_reindex;
            opts.exclude_pattern = config.exclude_pattern;
            opts.chunk_words = config.chunk_words;
            opts.overlap_words = config.overlap_words;
            opts.max_video_duration_seconds = config.max_video_duration_seconds;
            opts.max_file_size_mb = config.max_file_size_mb;
            opts.force_large = config.force_large;
            opts.classify_intent = config.classify_intent;
            opts.use_vlm_tagging = config.use_vlm_tagging;
            opts.vlm_endpoint = config.vlm_endpoint;
            opts.vlm_model = config.vlm_model;
            
            // Create indexer and scan
            omni::search::Indexer indexer(config.db_path, eng_cfg, opts);
            indexer.scan_directory(target_dir);
            
        } else if (command == "search") {
            if (argc < 3) {
                spdlog::error("Usage: {} search <query> or {} search --image <path>", argv[0], argv[0]);
                return 1;
            }
            
            // Check for --image flag
            bool image_query = false;
            std::string query;
            
            if (std::string(argv[2]) == "--image") {
                if (argc < 4) {
                    spdlog::error("Usage: {} search --image <path>", argv[0]);
                    return 1;
                }
                image_query = true;
                query = argv[3];
            } else {
                // Concatenate all args as text query
                for (int i = 2; i < argc; ++i) {
                    if (std::string(argv[i]).substr(0, 2) == "--") break;
                    if (i > 2) query += " ";
                    query += argv[i];
                }
            }
            
            spdlog::info("Searching for: {}", query);
            
            // Create embedding engine config
            omni::search::EmbeddingEngineConfig eng_cfg;
            eng_cfg.model_dir = config.model_dir;
            eng_cfg.clip_model = config.clip_model;
            eng_cfg.use_trt = config.use_tensorrt;
            
            // Create search engine options
            omni::search::SearchEngine::Options search_opts;
            search_opts.top_k = config.top_k;
            search_opts.min_score = config.min_score;
            
            // Create search engine
            omni::search::SearchEngine engine(config.db_path, eng_cfg, search_opts);
            
            // Execute query
            std::vector<omni::search::SearchResult> results;
            if (image_query) {
                results = engine.query_image(query);
            } else {
                results = engine.query(query);
            }
            
            // Display results
            if (results.empty()) {
                spdlog::info("No results found");
            } else {
                spdlog::info("Found {} results:", results.size());
                for (const auto& res : results) {
                    std::cout << "[" << res.score << "] ";
                    std::cout << "[" << res.type << "] ";
                    std::cout << res.path;
                    if (res.type == "video_segment" || res.type == "audio_segment") {
                        std::cout << " @ " << res.timestamp << "s";
                    }
                    std::cout << std::endl;
                }
            }
            
        } else if (command == "chat") {
            spdlog::info("Starting RAG chatbot...");
            
            // Create embedding engine config
            omni::search::EmbeddingEngineConfig eng_cfg;
            eng_cfg.model_dir = config.model_dir;
            eng_cfg.clip_model = config.clip_model;
            eng_cfg.use_trt = config.use_tensorrt;
            
            // Create search engine options
            omni::search::SearchEngine::Options search_opts;
            search_opts.top_k = config.top_k;
            search_opts.min_score = config.min_score;
            
            // Create search engine
            auto engine = std::make_shared<omni::search::SearchEngine>(
                config.db_path, eng_cfg, search_opts
            );
            
            // Create chatbot config
            omni::ChatBot::Config chat_cfg;
            chat_cfg.llm_model_path = config.llm_model_path;
            chat_cfg.top_k_context = 5;
            
            // Start chat loop
            omni::ChatBot bot(engine, chat_cfg);
            bot.chat_loop();
            
        } else {
            spdlog::error("Unknown command: {}", command);
            print_usage(argv[0]);
            return 1;
        }
        
    } catch (const std::exception& e) {
        spdlog::error("Fatal error: {}", e.what());
        return 1;
    }
    
    return 0;
}
