#include "omni/chat/chatbot.hpp"
#include <spdlog/spdlog.h>
#include <iostream>
#include <sstream>
#include <cstdio>
#include <array>
#include <memory>

#ifdef _WIN32
#define popen _popen
#define pclose _pclose
#endif

using omni::search::SearchEngine;
using omni::search::SearchResult;

namespace omni {

ChatBot::ChatBot(std::shared_ptr<SearchEngine> engine, const Config& config)
    : engine_(engine), config_(config) {
    if (config_.llm_model_path.empty()) {
        spdlog::warn("No LLM configured - will show context only");
    }
}

void ChatBot::chat_loop() {
    std::cout << "\n=== OMNI-SEARCH RAG CHATBOT ===\n";
    std::cout << "Type 'exit' or 'quit' to end.\n\n";

    std::string query;
    while (true) {
        std::cout << "> ";
        if (!std::getline(std::cin, query)) break;

        query.erase(0, query.find_first_not_of(" \t\n\r"));
        if (query.size() > 0)
            query.erase(query.find_last_not_of(" \t\n\r") + 1);

        if (query.empty()) continue;
        if (query == "exit" || query == "quit") { std::cout << "Goodbye!\n"; break; }

        std::cout << "\n" << generate_answer(query) << "\n";
    }
}

std::string ChatBot::generate_answer(const std::string& query) {
    spdlog::info("Processing query: {}", query);

    auto results = engine_->query(query);

    if (results.empty()) {
        return "No relevant documents found.";
    }

    std::string response;
    std::string prompt = build_rag_prompt(results, query);

    if (!config_.llm_model_path.empty()) {
        response = call_llm(prompt);
    } else {
        response = "LLM not configured. Set llm_model_path in ~/.omni-search/config.json\n\nRetrieved Context:\n";
        for (size_t i = 0; i < results.size(); ++i) {
            response += std::to_string(i + 1) + ". " + results[i].path;
            if (!results[i].metadata_json.empty()) {
                response += " (" + results[i].metadata_json + ")";
            }
            response += " [score: " + std::to_string(results[i].score) + "]\n";
        }
    }

    response += "\n\nSources:\n";
    for (size_t i = 0; i < results.size(); ++i) {
        response += "[" + std::to_string(i + 1) + "] " + results[i].path;
        response += " (score: " + std::to_string(results[i].score) + ")\n";
    }

    return response;
}

std::string ChatBot::build_rag_prompt(const std::vector<SearchResult>& context,
                                       const std::string& query) {
    std::ostringstream oss;
    oss << "You are a helpful assistant. Answer based on the provided context.\n\nContext:\n";

    for (size_t i = 0; i < context.size(); ++i) {
        oss << (i + 1) << ". Path: " << context[i].path;
        if (!context[i].metadata_json.empty()) {
            oss << " | Metadata: " << context[i].metadata_json;
        }
        oss << "\n";
    }

    oss << "\nQuestion: " << query << "\n\nAnswer:";
    return oss.str();
}

std::string ChatBot::call_llm(const std::string& prompt) {
    std::string escaped = prompt;
    size_t pos = 0;
    while ((pos = escaped.find("'", pos)) != std::string::npos) {
        escaped.replace(pos, 1, "'\\''");
        pos += 4;
    }

#ifdef _WIN32
    std::string cmd = "llama-cli -m \"" + config_.llm_model_path + "\" -p \"" + prompt + "\" -n 512 --no-display-prompt 2>&1";
#else
    std::string cmd = "llama-cli -m '" + config_.llm_model_path + "' -p '" + escaped + "' -n 512 --no-display-prompt 2>&1";
#endif

    spdlog::debug("Executing LLM: {}", cmd);

    std::array<char, 128> buffer;
    std::string result;
    std::unique_ptr<FILE, decltype(&pclose)> pipe(popen(cmd.c_str(), "r"), pclose);

    if (!pipe) {
        spdlog::error("Failed to execute llama-cli");
        return "Error: Failed to execute LLM";
    }

    while (fgets(buffer.data(), buffer.size(), pipe.get()) != nullptr) {
        result += buffer.data();
    }

    int exit_code = pclose(pipe.release());
    if (exit_code != 0) {
        spdlog::error("llama-cli exited with code {}", exit_code);
        return "Error: LLM failed (exit code: " + std::to_string(exit_code) + ")";
    }

    return result;
}

} // namespace omni