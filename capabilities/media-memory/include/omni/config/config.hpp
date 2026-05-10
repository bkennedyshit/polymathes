#pragma once

#include <string>
#include <nlohmann/json.hpp>

namespace omni {
namespace config {

struct AppConfig {
    // Database and storage
    std::string db_path = "~/.omni-search/omni_index.db";
    
    // Model configuration
    std::string model_dir = "models/";
    std::string clip_model = "openclip-vit-l14-336";  // default: best zero-shot retrieval
    
    // LLM configuration
    std::string llm_model_path = "";  // empty = no LLM, show context only
    
    // Indexing configuration
    double frame_interval = 2.0;  // seconds between video frames
    int chunk_words = 200;         // words per text chunk
    int overlap_words = 20;        // overlap between chunks
    
    // Search configuration
    int top_k = 10;                // number of results to return
    float min_score = 0.25;        // minimum cosine similarity score
    
    // Logging configuration
    std::string log_level = "info";  // debug, info, warn, error
    
    // Advanced
    bool use_tensorrt = true;      // try TensorRT first, fallback to ONNX Runtime
    bool force_reindex = false;    // re-index even if already indexed
    std::string exclude_pattern = "";  // glob pattern for directories to skip

    // Size/duration guardrails — prevent accidental indexing of raw 4K footage
    // that would take hours and retrieve badly. Override with --force-large.
    double max_video_duration_seconds = 600.0;  // 10 min (reels/shorts/clips)
    double max_file_size_mb = 2048.0;           // 2 GB
    bool force_large = false;                   // bypass guardrails when user opts in

    // Content intent classification — aspect ratio + path heuristics
    bool classify_intent = true;

    // Optional VLM tagging (Ollama or compatible)
    bool use_vlm_tagging = false;
    std::string vlm_endpoint = "http://localhost:11434/api/generate";
    std::string vlm_model = "qwen2.5vl:7b";
};

// Load config from JSON file, with defaults for missing fields
AppConfig load_config(const std::string& path);

// Save default config template to file
void save_default_config(const std::string& path);

// Expand ~ to home directory
std::string expand_home(const std::string& path);

// Parse config from JSON object
void from_json(const nlohmann::json& j, AppConfig& cfg);

// Serialize config to JSON object
void to_json(nlohmann::json& j, const AppConfig& cfg);

}  // namespace config
}  // namespace omni
