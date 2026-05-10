#include "omni/search/storage.hpp"
#include <spdlog/spdlog.h>
#include <filesystem>
#include <cstring>

namespace omni {
namespace search {

Storage::Storage(const std::string& db_path) {
    // Create directory if needed
    std::filesystem::path path(db_path);
    if (path.has_parent_path()) {
        std::filesystem::create_directories(path.parent_path());
    }
    
    // Open database
    int rc = sqlite3_open(db_path.c_str(), &db_);
    if (rc != SQLITE_OK) {
        const char* err = sqlite3_errmsg(db_);
        spdlog::error("Failed to open database: {}", err);
        sqlite3_close(db_);
        throw std::runtime_error("Failed to open database: " + db_path);
    }
    
    spdlog::info("Opened database: {}", db_path);
    
    // Enable WAL mode for better concurrent read performance
    char* err_msg = nullptr;
    rc = sqlite3_exec(db_, "PRAGMA journal_mode=WAL;", nullptr, nullptr, &err_msg);
    if (rc != SQLITE_OK) {
        spdlog::warn("Failed to enable WAL mode: {}", err_msg);
        sqlite3_free(err_msg);
    } else {
        spdlog::debug("Enabled WAL journal mode");
    }
    
    init_database();
    prepare_statements();
}

Storage::~Storage() {
    finalize_statements();
    if (db_) {
        sqlite3_close(db_);
        spdlog::debug("Closed database");
    }
}

void Storage::init_database() {
    const char* schema = R"(
        CREATE TABLE IF NOT EXISTS assets (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            path      TEXT    NOT NULL UNIQUE,
            type      TEXT    NOT NULL,
            timestamp REAL    NOT NULL DEFAULT 0.0,
            embedding BLOB    NOT NULL,
            metadata  TEXT    NOT NULL DEFAULT '{}'
        );
        
        CREATE INDEX IF NOT EXISTS idx_assets_path ON assets(path);
        CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
    )";
    
    char* err_msg = nullptr;
    int rc = sqlite3_exec(db_, schema, nullptr, nullptr, &err_msg);
    if (rc != SQLITE_OK) {
        std::string error = err_msg;
        sqlite3_free(err_msg);
        spdlog::error("Failed to create schema: {}", error);
        throw std::runtime_error("Failed to create schema: " + error);
    }
    
    spdlog::debug("Database schema initialized");
}

void Storage::prepare_statements() {
    // INSERT OR REPLACE statement
    const char* sql_insert = R"(
        INSERT OR REPLACE INTO assets (path, type, timestamp, embedding, metadata)
        VALUES (?, ?, ?, ?, ?)
    )";
    
    int rc = sqlite3_prepare_v2(db_, sql_insert, -1, &stmt_insert_, nullptr);
    if (rc != SQLITE_OK) {
        spdlog::error("Failed to prepare insert statement: {}", sqlite3_errmsg(db_));
        throw std::runtime_error("Failed to prepare insert statement");
    }
    
    // HAS_PATH statement
    const char* sql_has_path = "SELECT COUNT(*) FROM assets WHERE path = ?";
    rc = sqlite3_prepare_v2(db_, sql_has_path, -1, &stmt_has_path_, nullptr);
    if (rc != SQLITE_OK) {
        spdlog::error("Failed to prepare has_path statement: {}", sqlite3_errmsg(db_));
        throw std::runtime_error("Failed to prepare has_path statement");
    }
    
    // GET_BY_ID statement
    const char* sql_get_by_id = "SELECT id, path, type, timestamp, embedding, metadata FROM assets WHERE id = ?";
    rc = sqlite3_prepare_v2(db_, sql_get_by_id, -1, &stmt_get_by_id_, nullptr);
    if (rc != SQLITE_OK) {
        spdlog::error("Failed to prepare get_by_id statement: {}", sqlite3_errmsg(db_));
        throw std::runtime_error("Failed to prepare get_by_id statement");
    }
    
    // COUNT statement
    const char* sql_count = "SELECT COUNT(*) FROM assets";
    rc = sqlite3_prepare_v2(db_, sql_count, -1, &stmt_count_, nullptr);
    if (rc != SQLITE_OK) {
        spdlog::error("Failed to prepare count statement: {}", sqlite3_errmsg(db_));
        throw std::runtime_error("Failed to prepare count statement");
    }
    
    spdlog::debug("Prepared SQL statements");
}

void Storage::finalize_statements() {
    if (stmt_insert_) sqlite3_finalize(stmt_insert_);
    if (stmt_has_path_) sqlite3_finalize(stmt_has_path_);
    if (stmt_get_by_id_) sqlite3_finalize(stmt_get_by_id_);
    if (stmt_count_) sqlite3_finalize(stmt_count_);
}

std::vector<uint8_t> Storage::serialize_embedding(const std::vector<float>& embedding) {
    std::vector<uint8_t> blob(embedding.size() * sizeof(float));
    std::memcpy(blob.data(), embedding.data(), blob.size());
    return blob;
}

std::vector<float> Storage::deserialize_embedding(const void* blob, int size) {
    std::vector<float> embedding(size / sizeof(float));
    std::memcpy(embedding.data(), blob, size);
    return embedding;
}

void Storage::save_asset(const AssetRecord& asset) {
    sqlite3_reset(stmt_insert_);
    
    // Bind parameters
    sqlite3_bind_text(stmt_insert_, 1, asset.path.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt_insert_, 2, asset.type.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_double(stmt_insert_, 3, asset.timestamp);
    
    auto blob = serialize_embedding(asset.embedding);
    sqlite3_bind_blob(stmt_insert_, 4, blob.data(), static_cast<int>(blob.size()), SQLITE_TRANSIENT);
    
    sqlite3_bind_text(stmt_insert_, 5, asset.metadata_json.c_str(), -1, SQLITE_TRANSIENT);
    
    // Execute
    int rc = sqlite3_step(stmt_insert_);
    if (rc != SQLITE_DONE) {
        spdlog::error("Failed to insert asset: {}", sqlite3_errmsg(db_));
        throw std::runtime_error("Failed to insert asset: " + asset.path);
    }
    
    spdlog::debug("Saved asset: {} (type={}, dim={})", asset.path, asset.type, asset.embedding.size());
}

std::vector<std::pair<int64_t, std::vector<float>>> Storage::get_all_embeddings() {
    std::vector<std::pair<int64_t, std::vector<float>>> results;
    
    const char* sql = "SELECT id, embedding FROM assets";
    sqlite3_stmt* stmt = nullptr;
    
    int rc = sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr);
    if (rc != SQLITE_OK) {
        spdlog::error("Failed to prepare get_all_embeddings query: {}", sqlite3_errmsg(db_));
        return results;
    }
    
    while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
        int64_t id = sqlite3_column_int64(stmt, 0);
        const void* blob = sqlite3_column_blob(stmt, 1);
        int blob_size = sqlite3_column_bytes(stmt, 1);
        
        auto embedding = deserialize_embedding(blob, blob_size);
        results.emplace_back(id, std::move(embedding));
    }
    
    sqlite3_finalize(stmt);
    
    spdlog::debug("Retrieved {} embeddings", results.size());
    return results;
}

AssetRecord Storage::get_asset_by_id(int64_t id) {
    sqlite3_reset(stmt_get_by_id_);
    sqlite3_bind_int64(stmt_get_by_id_, 1, id);
    
    AssetRecord record;
    
    int rc = sqlite3_step(stmt_get_by_id_);
    if (rc == SQLITE_ROW) {
        record.id = sqlite3_column_int64(stmt_get_by_id_, 0);
        record.path = reinterpret_cast<const char*>(sqlite3_column_text(stmt_get_by_id_, 1));
        record.type = reinterpret_cast<const char*>(sqlite3_column_text(stmt_get_by_id_, 2));
        record.timestamp = sqlite3_column_double(stmt_get_by_id_, 3);
        
        const void* blob = sqlite3_column_blob(stmt_get_by_id_, 4);
        int blob_size = sqlite3_column_bytes(stmt_get_by_id_, 4);
        record.embedding = deserialize_embedding(blob, blob_size);
        
        record.metadata_json = reinterpret_cast<const char*>(sqlite3_column_text(stmt_get_by_id_, 5));
    } else if (rc == SQLITE_DONE) {
        spdlog::warn("Asset not found: id={}", id);
    } else {
        spdlog::error("Failed to query asset: {}", sqlite3_errmsg(db_));
    }
    
    return record;
}

bool Storage::has_path(const std::string& path) {
    sqlite3_reset(stmt_has_path_);
    sqlite3_bind_text(stmt_has_path_, 1, path.c_str(), -1, SQLITE_TRANSIENT);
    
    int rc = sqlite3_step(stmt_has_path_);
    if (rc == SQLITE_ROW) {
        int count = sqlite3_column_int(stmt_has_path_, 0);
        return count > 0;
    }
    
    return false;
}

int64_t Storage::asset_count() {
    sqlite3_reset(stmt_count_);
    
    int rc = sqlite3_step(stmt_count_);
    if (rc == SQLITE_ROW) {
        return sqlite3_column_int64(stmt_count_, 0);
    }
    
    return 0;
}

}  // namespace search
}  // namespace omni
