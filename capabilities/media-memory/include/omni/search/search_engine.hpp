#pragma once

#include <string>
#include <vector>
#include <memory>

namespace omni {
namespace search {

// Forward declarations
class EmbeddingEngine;
struct EmbeddingEngineConfig;
class Storage;

/**
 * Result from a search query
 */
struct SearchResult {
    std::string path;           // File path
    std::string type;           // Asset type (image, video_segment, etc.)
    double timestamp;           // Timestamp for video/audio segments
    float score;                // Similarity score (0.0 to 1.0)
    std::string metadata_json;  // Additional metadata as JSON
};

/**
 * Configuration options for SearchEngine
 */
struct SearchEngineOptions {
    int top_k = 10;             // Maximum number of results to return
    float min_score = 0.25f;    // Minimum similarity score threshold
};

/**
 * Search engine for querying indexed assets
 * Supports both text and image queries
 */
class SearchEngine {
public:
    using Options = SearchEngineOptions;

    /**
     * Construct search engine with database path, embedding config, and options
     * @param db_path Path to SQLite database
     * @param embed_config Configuration for embedding engine
     * @param opts Search engine options
     */
    SearchEngine(const std::string& db_path,
                 const EmbeddingEngineConfig& embed_config,
                 const Options& opts = Options{});
    
    ~SearchEngine();

    /**
     * Query the database using text
     * @param text Query text
     * @return Vector of search results sorted by relevance
     */
    std::vector<SearchResult> query(const std::string& text);

    /**
     * Query the database using an image
     * @param image_path Path to query image
     * @return Vector of search results sorted by relevance
     */
    std::vector<SearchResult> query_image(const std::string& image_path);

private:
    /**
     * Rank all database embeddings against a query vector
     * @param query_vec Query embedding vector (normalized)
     * @return Sorted and filtered search results
     */
    std::vector<SearchResult> rank(const std::vector<float>& query_vec);

    // Core components
    std::unique_ptr<EmbeddingEngine> engine_;
    std::unique_ptr<Storage> storage_;
    Options opts_;
};

} // namespace search
} // namespace omni
