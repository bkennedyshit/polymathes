#include "omni/search/search_engine.hpp"
#include "omni/search/embedding_engine.hpp"
#include "omni/search/storage.hpp"

#include <algorithm>
#include <opencv2/opencv.hpp>
#include <spdlog/spdlog.h>

namespace omni {
namespace search {

// =============================================================================
// Constructor / Destructor
// =============================================================================

SearchEngine::SearchEngine(const std::string& db_path,
                           const EmbeddingEngineConfig& embed_config,
                           const Options& opts)
    : opts_(opts)
{
    spdlog::info("[SearchEngine] Initializing with database: {}", db_path);
    
    // Initialize embedding engine
    engine_ = std::make_unique<EmbeddingEngine>(embed_config);
    spdlog::info("[SearchEngine] Embedding engine loaded (dim={})", engine_->embedding_dim());
    
    // Initialize storage
    storage_ = std::make_unique<Storage>(db_path);
    int64_t asset_count = storage_->asset_count();
    spdlog::info("[SearchEngine] Storage initialized ({} assets indexed)", asset_count);
}

SearchEngine::~SearchEngine() {
    spdlog::info("[SearchEngine] Shutdown");
}

// =============================================================================
// Query Methods
// =============================================================================

std::vector<SearchResult> SearchEngine::query(const std::string& text) {
    spdlog::info("[SearchEngine] Text query: '{}'", text);
    
    try {
        // Embed the query text
        std::vector<float> query_vec = engine_->embed_text(text);
        
        // Rank all results
        std::vector<SearchResult> results = rank(query_vec);
        
        spdlog::info("[SearchEngine] Found {} results", results.size());
        return results;
        
    } catch (const std::exception& e) {
        spdlog::error("[SearchEngine] Error in text query: {}", e.what());
        return {};
    }
}

std::vector<SearchResult> SearchEngine::query_image(const std::string& image_path) {
    spdlog::info("[SearchEngine] Image query: '{}'", image_path);
    
    try {
        // Load image
        cv::Mat image = cv::imread(image_path);
        if (image.empty()) {
            spdlog::error("[SearchEngine] Failed to read image: {}", image_path);
            return {};
        }
        
        // Embed the query image
        std::vector<float> query_vec = engine_->embed_image(image);
        
        // Rank all results
        std::vector<SearchResult> results = rank(query_vec);
        
        spdlog::info("[SearchEngine] Found {} results", results.size());
        return results;
        
    } catch (const std::exception& e) {
        spdlog::error("[SearchEngine] Error in image query: {}", e.what());
        return {};
    }
}

// =============================================================================
// Ranking
// =============================================================================

std::vector<SearchResult> SearchEngine::rank(const std::vector<float>& query_vec) {
    try {
        // Get all embeddings from database
        auto all_embeddings = storage_->get_all_embeddings();
        
        if (all_embeddings.empty()) {
            spdlog::warn("[SearchEngine] No embeddings in database");
            return {};
        }

        // Compute cosine similarity for each embedding
        // Since embeddings are pre-normalized, dot product = cosine similarity
        struct ScoredResult {
            int64_t id;
            float score;
        };
        
        std::vector<ScoredResult> scored_results;
        scored_results.reserve(all_embeddings.size());

        for (const auto& [id, embedding] : all_embeddings) {
            // Compute dot product (embeddings are already normalized)
            float dot_product = 0.0f;
            for (size_t i = 0; i < query_vec.size() && i < embedding.size(); ++i) {
                dot_product += query_vec[i] * embedding[i];
            }
            
            // Filter by minimum score
            if (dot_product >= opts_.min_score) {
                scored_results.push_back({id, dot_product});
            }
        }

        // Sort by score descending
        std::sort(scored_results.begin(), scored_results.end(),
                  [](const ScoredResult& a, const ScoredResult& b) {
                      return a.score > b.score;
                  });

        // Take top K results
        size_t result_count = std::min(static_cast<size_t>(opts_.top_k), 
                                       scored_results.size());
        
        // Fetch full asset records and build results
        std::vector<SearchResult> results;
        results.reserve(result_count);

        for (size_t i = 0; i < result_count; ++i) {
            try {
                AssetRecord asset = storage_->get_asset_by_id(scored_results[i].id);
                
                SearchResult result;
                result.path = asset.path;
                result.type = asset.type;
                result.timestamp = asset.timestamp;
                result.score = scored_results[i].score;
                result.metadata_json = asset.metadata_json;
                
                results.push_back(std::move(result));
                
            } catch (const std::exception& e) {
                spdlog::error("[SearchEngine] Error fetching asset {}: {}", 
                              scored_results[i].id, e.what());
            }
        }

        return results;
        
    } catch (const std::exception& e) {
        spdlog::error("[SearchEngine] Error in rank: {}", e.what());
        return {};
    }
}

} // namespace search
} // namespace omni
