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
 * Configuration options for the Indexer
 */
struct IndexerOptions {
    double frame_interval = 2.0;        // Seconds between video frame captures
    bool force_reindex = false;         // Re-index files even if already in DB
    std::string exclude_pattern = "";   // Skip directories matching this pattern
    int top_k = 10;                     // Top K results (unused in indexer but kept for consistency)
    int chunk_words = 200;              // Words per text chunk
    int overlap_words = 20;             // Overlapping words between chunks

    // Size/duration guardrails — protect users from accidentally indexing raw
    // 4K footage that would take hours and give poor retrieval quality.
    // Set force_large=true (or --force-large on CLI) to override.
    double max_video_duration_seconds = 600.0;  // 10 minutes default — reels/shorts/clips
    double max_file_size_mb = 2048.0;           // 2 GB default
    bool force_large = false;                   // Bypass guardrails when user confirms

    // Content intent classification — adds a best-guess `intent` tag
    // (pin / post / story / reel / short / thumbnail / photo / other)
    // to every indexed asset based on aspect ratio + folder hints.
    bool classify_intent = true;

    // Optional: call a local VLM (Ollama) to generate free-form tags per image.
    // When enabled, indexing is slower but retrieval by tag becomes possible.
    // Example: vlm_endpoint="http://localhost:11434/api/generate", vlm_model="qwen2.5vl:7b"
    bool use_vlm_tagging = false;
    std::string vlm_endpoint = "http://localhost:11434/api/generate";
    std::string vlm_model = "qwen2.5vl:7b";
};

/**
 * Indexer for scanning and embedding files into the search database
 * Handles images, videos, audio, and text files
 */
class Indexer {
public:
    using Options = IndexerOptions;

    /**
     * Construct indexer with database path, embedding config, and options
     * @param db_path Path to SQLite database
     * @param embed_config Configuration for embedding engine
     * @param opts Indexer options
     */
    Indexer(const std::string& db_path, 
            const EmbeddingEngineConfig& embed_config,
            const Options& opts = Options{});
    
    ~Indexer();

    /**
     * Recursively scan directory and index all supported files
     * @param root_path Root directory to scan
     */
    void scan_directory(const std::string& root_path);

    /**
     * Process and index an image file
     * Supported formats: .jpg, .jpeg, .png, .webp, .bmp
     * @param path Path to image file
     */
    void process_image(const std::string& path);

    /**
     * Process and index a video file by extracting frames
     * Supported formats: .mp4, .mov, .mkv, .avi
     * @param path Path to video file
     */
    void process_video(const std::string& path);

    /**
     * Process and index an audio file via transcription
     * Supported formats: .wav, .mp3, .flac, .m4a
     * @param path Path to audio file
     */
    void process_audio(const std::string& path);

    /**
     * Process and index a text or code file
     * Text formats: .txt, .md, .pdf
     * Code formats: .cpp, .h, .hpp, .py, .js, .ts, .rs, .go, .java
     * @param path Path to text/code file
     */
    void process_text(const std::string& path);

private:
    /**
     * Split text into overlapping chunks for embedding
     * @param text Input text to chunk
     * @param chunk_words Number of words per chunk
     * @param overlap_words Number of overlapping words
     * @return Vector of text chunks
     */
    std::vector<std::string> chunk_text(const std::string& text, 
                                        int chunk_words, 
                                        int overlap_words);

    /**
     * Extract text from PDF file using pdfplumber subprocess
     * @param path Path to PDF file
     * @return Extracted text content
     */
    std::string extract_pdf_text(const std::string& path);

    /**
     * Transcribe audio file using whisper.cpp subprocess
     * @param path Path to audio file
     * @return Transcribed text
     */
    std::string transcribe_audio(const std::string& path);

    /**
     * Infer a brand/project tag from the file path using the convention:
     *   {root}/content/{brand}/... → brand
     * Returns empty string if the pattern doesn't match.
     */
    static std::string infer_brand(const std::string& path);

    /**
     * Build a base metadata JSON object for an asset with inferred tags
     * (brand, is_reel, is_photo, etc.) from its path. Callers can add
     * asset-specific fields (frame_idx, chunk_idx) on top.
     */
    static std::string build_metadata(const std::string& path,
                                      const std::string& extra_json = "");

    /**
     * Classify content intent from aspect ratio + folder path.
     * Returns one of: "pin", "post", "story", "reel", "short",
     * "thumbnail", "photo", "other". Heuristic-only, cheap.
     */
    static std::string classify_intent(const std::string& path, int width, int height);

    /**
     * Call an Ollama-hosted vision model (qwen2.5vl, llava, etc.) to produce
     * 3-5 short tags for an image. Returns a JSON array string, or empty on
     * failure. Blocking, slow (hundreds of ms per call) — only called when
     * opts_.use_vlm_tagging is true.
     */
    std::string vlm_tag_image(const std::string& path) const;

    /**
     * Size guardrail — returns true if the file exceeds max_file_size_mb
     * and force_large is not set. Logs a warning pointing at --force-large.
     */
    bool exceeds_size_guardrail(const std::string& path) const;

    // Core components
    std::unique_ptr<EmbeddingEngine> engine_;
    std::unique_ptr<Storage> storage_;
    Options opts_;

    // Statistics counters
    int files_scanned_ = 0;
    int files_indexed_ = 0;
    int files_skipped_ = 0;
    int files_errored_ = 0;
};

} // namespace search
} // namespace omni
