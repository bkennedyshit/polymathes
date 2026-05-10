#pragma once

#include <memory>
#include <string>
#include <vector>
#include "omni/search/search_engine.hpp"

namespace omni {

class ChatBot {
public:
    struct Config {
        std::string llm_model_path;
        int top_k_context = 5;
    };

    ChatBot(std::shared_ptr<omni::search::SearchEngine> engine, const Config& config);

    void chat_loop();
    std::string generate_answer(const std::string& query);

private:
    std::string build_rag_prompt(const std::vector<omni::search::SearchResult>& context,
                                  const std::string& query);
    std::string call_llm(const std::string& prompt);

    std::shared_ptr<omni::search::SearchEngine> engine_;
    Config config_;
};

} // namespace omni
