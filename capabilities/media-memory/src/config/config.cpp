#include "omni/config/config.hpp"
#include <fstream>
#include <filesystem>
#include <spdlog/spdlog.h>

#ifdef _WIN32
#include <windows.h>
#include <shlobj.h>
#else
#include <unistd.h>
#include <pwd.h>
#endif

namespace omni {
namespace config {

std::string expand_home(const std::string& path) {
    if (path.empty() || path[0] != '~') {
        return path;
    }
    
    std::string home;
#ifdef _WIN32
    char* userprofile = std::getenv("USERPROFILE");
    if (userprofile) {
        home = userprofile;
    } else {
        char* homedrive = std::getenv("HOMEDRIVE");
        char* homepath = std::getenv("HOMEPATH");
        if (homedrive && homepath) {
            home = std::string(homedrive) + homepath;
        }
    }
#else
    const char* home_env = std::getenv("HOME");
    if (home_env) {
        home = home_env;
    } else {
        struct passwd* pw = getpwuid(getuid());
        if (pw) {
            home = pw->pw_dir;
        }
    }
#endif
    
    if (home.empty()) {
        return path;  // fallback: return as-is
    }
    
    return home + path.substr(1);
}

void from_json(const nlohmann::json& j, AppConfig& cfg) {
    if (j.contains("db_path")) cfg.db_path = j["db_path"].get<std::string>();
    if (j.contains("model_dir")) cfg.model_dir = j["model_dir"].get<std::string>();
    if (j.contains("clip_model")) cfg.clip_model = j["clip_model"].get<std::string>();
    if (j.contains("llm_model_path")) cfg.llm_model_path = j["llm_model_path"].get<std::string>();
    if (j.contains("frame_interval")) cfg.frame_interval = j["frame_interval"].get<double>();
    if (j.contains("chunk_words")) cfg.chunk_words = j["chunk_words"].get<int>();
    if (j.contains("overlap_words")) cfg.overlap_words = j["overlap_words"].get<int>();
    if (j.contains("top_k")) cfg.top_k = j["top_k"].get<int>();
    if (j.contains("min_score")) cfg.min_score = j["min_score"].get<float>();
    if (j.contains("log_level")) cfg.log_level = j["log_level"].get<std::string>();
    if (j.contains("use_tensorrt")) cfg.use_tensorrt = j["use_tensorrt"].get<bool>();
    if (j.contains("force_reindex")) cfg.force_reindex = j["force_reindex"].get<bool>();
    if (j.contains("exclude_pattern")) cfg.exclude_pattern = j["exclude_pattern"].get<std::string>();
}

void to_json(nlohmann::json& j, const AppConfig& cfg) {
    j = nlohmann::json{
        {"db_path", cfg.db_path},
        {"model_dir", cfg.model_dir},
        {"clip_model", cfg.clip_model},
        {"llm_model_path", cfg.llm_model_path},
        {"frame_interval", cfg.frame_interval},
        {"chunk_words", cfg.chunk_words},
        {"overlap_words", cfg.overlap_words},
        {"top_k", cfg.top_k},
        {"min_score", cfg.min_score},
        {"log_level", cfg.log_level},
        {"use_tensorrt", cfg.use_tensorrt},
        {"force_reindex", cfg.force_reindex},
        {"exclude_pattern", cfg.exclude_pattern}
    };
}

AppConfig load_config(const std::string& path) {
    AppConfig cfg;  // start with defaults
    
    std::string expanded_path = expand_home(path);
    
    if (!std::filesystem::exists(expanded_path)) {
        spdlog::debug("Config file not found: {}", expanded_path);
        return cfg;
    }
    
    try {
        std::ifstream file(expanded_path);
        if (!file.is_open()) {
            spdlog::warn("Failed to open config file: {}", expanded_path);
            return cfg;
        }
        
        nlohmann::json j;
        file >> j;
        from_json(j, cfg);
        
        spdlog::info("Loaded config from: {}", expanded_path);
    } catch (const std::exception& e) {
        spdlog::error("Failed to parse config file: {}", e.what());
    }
    
    return cfg;
}

void save_default_config(const std::string& path) {
    std::string expanded_path = expand_home(path);
    
    // Create directory if it doesn't exist
    std::filesystem::path dir = std::filesystem::path(expanded_path).parent_path();
    if (!dir.empty() && !std::filesystem::exists(dir)) {
        std::filesystem::create_directories(dir);
        spdlog::debug("Created config directory: {}", dir.string());
    }
    
    AppConfig default_cfg;
    nlohmann::json j;
    to_json(j, default_cfg);
    
    try {
        std::ofstream file(expanded_path);
        if (!file.is_open()) {
            spdlog::error("Failed to create config file: {}", expanded_path);
            return;
        }
        
        file << j.dump(4) << std::endl;
        spdlog::info("Created default config at: {}", expanded_path);
    } catch (const std::exception& e) {
        spdlog::error("Failed to write config file: {}", e.what());
    }
}

}  // namespace config
}  // namespace omni
