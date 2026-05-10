#pragma once

#include <string>
#include <vector>
#include <memory>
#include <sqlite3.h>

namespace omni {
namespace search {

struct AssetRecord {
    int64_t id{0};
    std::string path;
    std::string type;  // "image", "video_segment", "audio_segment", "document", "code"
    double timestamp{0.0};  // for video/audio segments
    std::vector<float> embedding;
    std::string metadata_json{"{}"}; // Additional metadata as JSON
};

class Storage {
public:
    explicit Storage(const std::string& db_path);
    ~Storage();
    
    // Disable copy/move
    Storage(const Storage&) = delete;
    Storage& operator=(const Storage&) = delete;
    
    // Insert or replace asset
    void save_asset(const AssetRecord& asset);
    
    // Returns all (id, embedding) pairs for similarity search
    std::vector<std::pair<int64_t, std::vector<float>>> get_all_embeddings();
    
    // Full record by ID
    AssetRecord get_asset_by_id(int64_t id);
    
    // Check if path already indexed
    bool has_path(const std::string& path);
    
    // Get total asset count
    int64_t asset_count();
    
private:
    void init_database();
    void prepare_statements();
    void finalize_statements();
    
    static std::vector<float> deserialize_embedding(const void* blob, int size);
    static std::vector<uint8_t> serialize_embedding(const std::vector<float>& embedding);
    
    sqlite3* db_{nullptr};
    sqlite3_stmt* stmt_insert_{nullptr};
    sqlite3_stmt* stmt_has_path_{nullptr};
    sqlite3_stmt* stmt_get_by_id_{nullptr};
    sqlite3_stmt* stmt_count_{nullptr};
};

}  // namespace search
}  // namespace omni
