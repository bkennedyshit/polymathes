#include "omni/search/indexer.hpp"
#include "omni/search/embedding_engine.hpp"
#include "omni/search/storage.hpp"

#include <filesystem>
#include <fstream>
#include <sstream>
#include <algorithm>
#include <opencv2/opencv.hpp>
#include <spdlog/spdlog.h>
#include <nlohmann/json.hpp>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omni {
namespace search {

// =============================================================================
// Constructor / Destructor
// =============================================================================

Indexer::Indexer(const std::string& db_path, 
                 const EmbeddingEngineConfig& embed_config,
                 const Options& opts)
    : opts_(opts)
{
    spdlog::info("[Indexer] Initializing with database: {}", db_path);
    
    // Initialize embedding engine
    engine_ = std::make_unique<EmbeddingEngine>(embed_config);
    spdlog::info("[Indexer] Embedding engine loaded (dim={})", engine_->embedding_dim());
    
    // Initialize storage
    storage_ = std::make_unique<Storage>(db_path);
    spdlog::info("[Indexer] Storage initialized ({} existing assets)", 
                 storage_->asset_count());
}

Indexer::~Indexer() {
    spdlog::info("[Indexer] Shutdown");
}

// =============================================================================
// Helpers — brand inference, metadata builder, size guardrail
// =============================================================================

std::string Indexer::infer_brand(const std::string& path) {
    // Convention: {anything}/content/<brand>/... → brand
    // Normalizes separators to forward-slash for matching.
    std::string norm = path;
    std::replace(norm.begin(), norm.end(), '\\', '/');
    const std::string marker = "/content/";
    auto pos = norm.find(marker);
    if (pos == std::string::npos) return "";
    auto start = pos + marker.size();
    auto end = norm.find('/', start);
    if (end == std::string::npos) return "";
    std::string brand = norm.substr(start, end - start);
    // Strip odd chars — brand should be simple slug-ish
    if (brand.empty() || brand.size() > 64) return "";
    return brand;
}

std::string Indexer::build_metadata(const std::string& path, const std::string& extra_json) {
    json meta;
    if (!extra_json.empty()) {
        try { meta = json::parse(extra_json); } catch (...) { meta = json::object(); }
    } else {
        meta = json::object();
    }

    // Brand inference
    std::string brand = infer_brand(path);
    if (!brand.empty()) meta["brand"] = brand;

    // Folder-category hints so the agent can filter: reels, shorts, photos, longform
    std::string norm = path;
    std::replace(norm.begin(), norm.end(), '\\', '/');
    auto contains_segment = [&](const std::string& seg) {
        return norm.find("/" + seg + "/") != std::string::npos;
    };
    if (contains_segment("reels"))    meta["category"] = "reels";
    else if (contains_segment("shorts"))   meta["category"] = "shorts";
    else if (contains_segment("photos"))   meta["category"] = "photos";
    else if (contains_segment("longform")) meta["category"] = "longform";
    else if (contains_segment("archive") || contains_segment("archives"))
                                           meta["category"] = "archive";

    return meta.dump();
}

bool Indexer::exceeds_size_guardrail(const std::string& path) const {
    if (opts_.force_large) return false;
    try {
        auto size_bytes = fs::file_size(path);
        double size_mb = static_cast<double>(size_bytes) / (1024.0 * 1024.0);
        if (size_mb > opts_.max_file_size_mb) {
            spdlog::warn(
                "[Indexer] Skipping large file ({:.1f} MB > {:.1f} MB limit): {} — "
                "this looks like raw/unedited content. Pass --force-large to index anyway, "
                "or edit it down first (reels/shorts/clips retrieve much better than raw footage).",
                size_mb, opts_.max_file_size_mb, path);
            return true;
        }
    } catch (const fs::filesystem_error&) {
        // Can't stat; let the downstream handler deal with it
    }
    return false;
}

// =============================================================================
// Content intent classification
// =============================================================================

std::string Indexer::classify_intent(const std::string& path, int width, int height) {
    // Path-based override first — if the user organised by intent, trust that.
    std::string norm = path;
    std::replace(norm.begin(), norm.end(), '\\', '/');
    auto has = [&](const std::string& seg) {
        return norm.find("/" + seg + "/") != std::string::npos ||
               norm.find("/" + seg + "s/") != std::string::npos;
    };
    if (has("pin"))       return "pin";
    if (has("post"))      return "post";
    if (has("story"))     return "story";
    if (has("reel"))      return "reel";
    if (has("short"))     return "short";
    if (has("thumbnail")) return "thumbnail";
    if (has("logo"))      return "logo";

    if (width <= 0 || height <= 0) return "other";
    double ratio = static_cast<double>(width) / static_cast<double>(height);

    // Common social media ratios (±5% tolerance)
    auto near = [&](double target) { return std::abs(ratio - target) / target < 0.05; };

    // 1:1 → Instagram post, album art
    if (near(1.0))                                    return "post";
    // 2:3 (0.667) → Pinterest pin, IG portrait
    if (near(0.667))                                  return "pin";
    // 4:5 (0.8) → IG portrait post
    if (near(0.8))                                    return "post";
    // 9:16 (0.5625) tall → Reel, TikTok, Story
    if (near(0.5625))                                 return "reel";
    // 16:9 (1.778) → YouTube thumbnail, landscape content
    if (near(1.778))                                  return "thumbnail";

    // Generic portrait vs landscape photo
    if (ratio >= 1.3 && ratio <= 1.5) return "photo";    // 4:3, 3:2
    if (ratio > 1.0)                  return "photo";    // wide photo
    return "other";
}

std::string Indexer::vlm_tag_image(const std::string& path) const {
    // Call Ollama /api/generate with base64-encoded image + tag prompt.
    // We shell out to curl rather than link a HTTP client — keeps C++ deps slim,
    // and if curl isn't on PATH the user gets a clear message.
    //
    // The prompt asks for 3-5 comma-separated tags, no explanation. We parse
    // the response line and normalize to a JSON array string.
    try {
        // Base64 encode the image file via a small python helper. Polymath ships
        // Python on most target systems and this keeps C++ boilerplate small.
        std::ostringstream cmd;
        cmd << "python -c \""
            << "import base64,json,sys,urllib.request;"
            << "data=base64.b64encode(open(r'" << path << "','rb').read()).decode();"
            << "body=json.dumps({"
            <<   "'model':'" << opts_.vlm_model << "',"
            <<   "'prompt':'Output 3-5 short comma-separated tags for this image. "
            <<              "Focus on content type (pin, post, photo, thumbnail), "
            <<              "subject, scene, and brand-relevant attributes. "
            <<              "No explanation. Tags only.',"
            <<   "'images':[data],'stream':False"
            << "}).encode();"
            << "req=urllib.request.Request('" << opts_.vlm_endpoint << "',data=body,"
            << "headers={'Content-Type':'application/json'});"
            << "resp=urllib.request.urlopen(req,timeout=30);"
            << "print(json.loads(resp.read()).get('response','').strip())\"";

        FILE* pipe = _popen(cmd.str().c_str(), "r");
        if (!pipe) return "";

        std::ostringstream result;
        char buffer[512];
        while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
            result << buffer;
        }
        _pclose(pipe);

        std::string raw = result.str();
        // Trim whitespace
        while (!raw.empty() && (raw.back() == '\n' || raw.back() == '\r' || raw.back() == ' ')) raw.pop_back();
        if (raw.empty()) return "";

        // Split on commas into a JSON array
        json tags = json::array();
        std::istringstream iss(raw);
        std::string tag;
        while (std::getline(iss, tag, ',')) {
            // trim
            auto start = tag.find_first_not_of(" \t\r\n\"");
            auto end = tag.find_last_not_of(" \t\r\n\".");
            if (start == std::string::npos) continue;
            std::string cleaned = tag.substr(start, end - start + 1);
            if (!cleaned.empty() && cleaned.size() < 64) {
                // lowercase
                std::transform(cleaned.begin(), cleaned.end(), cleaned.begin(), ::tolower);
                tags.push_back(cleaned);
            }
        }
        if (tags.empty()) return "";
        return tags.dump();
    } catch (const std::exception& e) {
        spdlog::debug("[Indexer] VLM tagging failed for {}: {}", path, e.what());
        return "";
    }
}

// =============================================================================
// Directory Scanning
// =============================================================================

void Indexer::scan_directory(const std::string& root_path) {
    spdlog::info("[Indexer] Scanning directory: {}", root_path);
    
    if (!fs::exists(root_path)) {
        spdlog::error("[Indexer] Path does not exist: {}", root_path);
        return;
    }

    try {
        for (const auto& entry : fs::recursive_directory_iterator(
            root_path, fs::directory_options::skip_permission_denied)) 
        {
            try {
                // Skip directories matching exclude pattern
                if (entry.is_directory()) {
                    if (!opts_.exclude_pattern.empty() && 
                        entry.path().string().find(opts_.exclude_pattern) != std::string::npos) 
                    {
                        spdlog::debug("[Indexer] Skipping excluded directory: {}", 
                                      entry.path().string());
                        continue;
                    }
                }
                
                if (!entry.is_regular_file()) {
                    continue;
                }

                files_scanned_++;
                std::string path_str = entry.path().string();
                std::string ext = entry.path().extension().string();

                // Size guardrail — warns + skips large files unless force_large is set.
                // Applied once at dispatch time so all asset types benefit.
                if (exceeds_size_guardrail(path_str)) {
                    files_skipped_++;
                    continue;
                }

                // Normalize extension to lowercase
                std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);

                // Dispatch by extension
                if (ext == ".jpg" || ext == ".jpeg" || ext == ".png" || 
                    ext == ".webp" || ext == ".bmp") 
                {
                    process_image(path_str);
                }
                else if (ext == ".mp4" || ext == ".mov" || ext == ".mkv" || ext == ".avi") 
                {
                    process_video(path_str);
                }
                else if (ext == ".wav" || ext == ".mp3" || ext == ".flac" || ext == ".m4a") 
                {
                    process_audio(path_str);
                }
                else if (ext == ".txt" || ext == ".md" || ext == ".pdf") 
                {
                    process_text(path_str);
                }
                else if (ext == ".cpp" || ext == ".h" || ext == ".hpp" || 
                         ext == ".py" || ext == ".js" || ext == ".ts" || 
                         ext == ".rs" || ext == ".go" || ext == ".java") 
                {
                    process_text(path_str);
                }
                
            } catch (const fs::filesystem_error& e) {
                spdlog::error("[Indexer] Filesystem error on {}: {}", 
                              entry.path().string(), e.what());
                files_errored_++;
            } catch (const std::exception& e) {
                spdlog::error("[Indexer] Error processing {}: {}", 
                              entry.path().string(), e.what());
                files_errored_++;
            }
        }
    } catch (const fs::filesystem_error& e) {
        spdlog::error("[Indexer] Failed to iterate directory {}: {}", root_path, e.what());
    }

    // Print summary
    spdlog::info("[Indexer] Scan complete: Scanned {} files, indexed {}, skipped {}, errors {}",
                 files_scanned_, files_indexed_, files_skipped_, files_errored_);
}

// =============================================================================
// Image Processing
// =============================================================================

void Indexer::process_image(const std::string& path) {
    auto start_time = std::chrono::steady_clock::now();
    
    try {
        // Check if already indexed
        if (!opts_.force_reindex && storage_->has_path(path)) {
            spdlog::debug("[Indexer] Skipping already indexed image: {}", path);
            files_skipped_++;
            return;
        }

        // Load image
        cv::Mat image = cv::imread(path);
        if (image.empty()) {
            spdlog::warn("[Indexer] Failed to read image: {}", path);
            files_errored_++;
            return;
        }

        // Generate embedding
        std::vector<float> embedding = engine_->embed_image(image);

        // Build metadata with intent + optional VLM tags
        json image_meta = json::object();
        if (opts_.classify_intent) {
            image_meta["intent"] = classify_intent(path, image.cols, image.rows);
        }
        image_meta["width"]  = image.cols;
        image_meta["height"] = image.rows;
        if (opts_.use_vlm_tagging) {
            std::string tags_json = vlm_tag_image(path);
            if (!tags_json.empty()) {
                try { image_meta["vlm_tags"] = json::parse(tags_json); }
                catch (...) { /* bad json, skip */ }
            }
        }

        // Save to database
        AssetRecord asset;
        asset.path = path;
        asset.type = "image";
        asset.timestamp = 0.0;
        asset.embedding = std::move(embedding);
        asset.metadata_json = build_metadata(path, image_meta.dump());
        
        storage_->save_asset(asset);
        files_indexed_++;

        auto end_time = std::chrono::steady_clock::now();
        auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(
            end_time - start_time).count();
        
        spdlog::info("[Indexer] Indexed image: {} ({}ms)", path, duration);
        
    } catch (const std::exception& e) {
        spdlog::error("[Indexer] Error processing image {}: {}", path, e.what());
        files_errored_++;
    }
}

// =============================================================================
// Video Processing
// =============================================================================

void Indexer::process_video(const std::string& path) {
    try {
        // Check if already indexed
        if (!opts_.force_reindex && storage_->has_path(path)) {
            spdlog::debug("[Indexer] Skipping already indexed video: {}", path);
            files_skipped_++;
            return;
        }

        // Open video
        cv::VideoCapture cap(path);
        if (!cap.isOpened()) {
            spdlog::warn("[Indexer] Failed to open video: {}", path);
            files_errored_++;
            return;
        }

        double fps = cap.get(cv::CAP_PROP_FPS);
        int total_frames = static_cast<int>(cap.get(cv::CAP_PROP_FRAME_COUNT));
        
        if (fps <= 0 || total_frames <= 0) {
            spdlog::warn("[Indexer] Invalid video metadata: {} (fps={}, frames={})", 
                         path, fps, total_frames);
            files_errored_++;
            return;
        }

        // Duration guardrail — skip raw/unedited footage unless user forces it.
        double duration_seconds = static_cast<double>(total_frames) / fps;
        if (!opts_.force_large && duration_seconds > opts_.max_video_duration_seconds) {
            double minutes = duration_seconds / 60.0;
            double limit_min = opts_.max_video_duration_seconds / 60.0;
            spdlog::warn(
                "[Indexer] Skipping long video ({:.1f} min > {:.1f} min limit): {} — "
                "this looks like raw footage. Edit it down to reels/shorts for better "
                "retrieval, or pass --force-large to index anyway.",
                minutes, limit_min, path);
            files_skipped_++;
            return;
        }

        // Calculate frame stride
        int frame_stride = static_cast<int>(opts_.frame_interval * fps);
        if (frame_stride < 1) frame_stride = 1;

        // Classify the video's intent once (based on its dimensions + path)
        int vid_width  = static_cast<int>(cap.get(cv::CAP_PROP_FRAME_WIDTH));
        int vid_height = static_cast<int>(cap.get(cv::CAP_PROP_FRAME_HEIGHT));
        std::string video_intent = opts_.classify_intent
            ? classify_intent(path, vid_width, vid_height)
            : std::string{};

        spdlog::info("[Indexer] Processing video: {} (fps={:.1f}, frames={}, stride={}, duration={:.1f}s)", 
                     path, fps, total_frames, frame_stride, duration_seconds);

        int frames_processed = 0;
        int frames_to_process = (total_frames + frame_stride - 1) / frame_stride;
        int last_progress_percent = -1;

        for (int frame_idx = 0; frame_idx < total_frames; frame_idx += frame_stride) {
            try {
                cap.set(cv::CAP_PROP_POS_FRAMES, frame_idx);
                
                cv::Mat frame;
                if (!cap.read(frame) || frame.empty()) {
                    continue;
                }

                // Generate embedding
                std::vector<float> embedding = engine_->embed_image(frame);

                // Save frame segment
                AssetRecord asset;
                asset.path = path;
                asset.type = "video_segment";
                asset.timestamp = static_cast<double>(frame_idx) / fps;
                asset.embedding = std::move(embedding);
                
                json frame_meta;
                frame_meta["frame_idx"] = frame_idx;
                if (!video_intent.empty()) frame_meta["intent"] = video_intent;
                frame_meta["width"]  = vid_width;
                frame_meta["height"] = vid_height;
                asset.metadata_json = build_metadata(path, frame_meta.dump());
                
                storage_->save_asset(asset);
                frames_processed++;

                // Log progress every 10%
                int progress_percent = (frames_processed * 100) / frames_to_process;
                if (progress_percent >= last_progress_percent + 10) {
                    last_progress_percent = progress_percent;
                    spdlog::info("[Indexer] Video progress: {}% ({}/{})", 
                                 progress_percent, frames_processed, frames_to_process);
                }
                
            } catch (const std::exception& e) {
                spdlog::error("[Indexer] Error processing frame {} of {}: {}", 
                              frame_idx, path, e.what());
            }
        }

        files_indexed_++;
        spdlog::info("[Indexer] Indexed video: {} ({} frames)", path, frames_processed);
        
    } catch (const std::exception& e) {
        spdlog::error("[Indexer] Error processing video {}: {}", path, e.what());
        files_errored_++;
    }
}

// =============================================================================
// Audio Processing
// =============================================================================

void Indexer::process_audio(const std::string& path) {
    try {
        // Check if already indexed
        if (!opts_.force_reindex && storage_->has_path(path)) {
            spdlog::debug("[Indexer] Skipping already indexed audio: {}", path);
            files_skipped_++;
            return;
        }

        spdlog::info("[Indexer] Transcribing audio: {}", path);
        
        // Transcribe audio
        std::string transcript = transcribe_audio(path);
        
        if (transcript.empty()) {
            spdlog::warn("[Indexer] Empty transcription for audio: {}", path);
            files_errored_++;
            return;
        }

        // Chunk the transcript
        std::vector<std::string> chunks = chunk_text(transcript, 
                                                     opts_.chunk_words, 
                                                     opts_.overlap_words);

        spdlog::info("[Indexer] Processing {} text chunks from audio: {}", 
                     chunks.size(), path);

        for (size_t i = 0; i < chunks.size(); ++i) {
            try {
                // Generate embedding
                std::vector<float> embedding = engine_->embed_text(chunks[i]);

                // Save chunk
                AssetRecord asset;
                asset.path = path;
                asset.type = "audio_segment";
                asset.timestamp = 0.0;  // Would need Whisper segment timestamps
                asset.embedding = std::move(embedding);
                
                json audio_meta;
                audio_meta["chunk_idx"] = i;
                audio_meta["chunk_text"] = chunks[i].substr(0, 200);  // Preview
                asset.metadata_json = build_metadata(path, audio_meta.dump());
                
                storage_->save_asset(asset);
                
            } catch (const std::exception& e) {
                spdlog::error("[Indexer] Error embedding audio chunk {}: {}", i, e.what());
            }
        }

        files_indexed_++;
        spdlog::info("[Indexer] Indexed audio: {} ({} chunks)", path, chunks.size());
        
    } catch (const std::exception& e) {
        spdlog::error("[Indexer] Error processing audio {}: {}", path, e.what());
        files_errored_++;
    }
}

// =============================================================================
// Text Processing
// =============================================================================

void Indexer::process_text(const std::string& path) {
    try {
        // Check if already indexed
        if (!opts_.force_reindex && storage_->has_path(path)) {
            spdlog::debug("[Indexer] Skipping already indexed text: {}", path);
            files_skipped_++;
            return;
        }

        std::string text;
        std::string ext = fs::path(path).extension().string();
        std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);

        // Extract text based on file type
        if (ext == ".pdf") {
            text = extract_pdf_text(path);
        } else {
            // Read file directly
            std::ifstream file(path);
            if (!file.is_open()) {
                spdlog::warn("[Indexer] Failed to open text file: {}", path);
                files_errored_++;
                return;
            }
            
            std::stringstream buffer;
            buffer << file.rdbuf();
            text = buffer.str();
        }

        if (text.empty()) {
            spdlog::warn("[Indexer] Empty text content: {}", path);
            files_skipped_++;
            return;
        }

        // Determine type (document vs code)
        std::string asset_type = "document";
        if (ext == ".cpp" || ext == ".h" || ext == ".hpp" || 
            ext == ".py" || ext == ".js" || ext == ".ts" || 
            ext == ".rs" || ext == ".go" || ext == ".java") 
        {
            asset_type = "code";
        }

        // Chunk text
        std::vector<std::string> chunks = chunk_text(text, 
                                                     opts_.chunk_words, 
                                                     opts_.overlap_words);

        spdlog::info("[Indexer] Processing {} chunks from {}: {}", 
                     chunks.size(), asset_type, path);

        for (size_t i = 0; i < chunks.size(); ++i) {
            try {
                // Generate embedding
                std::vector<float> embedding = engine_->embed_text(chunks[i]);

                // Save chunk
                AssetRecord asset;
                asset.path = path;
                asset.type = asset_type;
                asset.timestamp = 0.0;
                asset.embedding = std::move(embedding);
                
                json text_meta;
                text_meta["chunk_idx"] = i;
                text_meta["chunk_text"] = chunks[i].substr(0, 200);  // Preview
                asset.metadata_json = build_metadata(path, text_meta.dump());
                
                storage_->save_asset(asset);
                
            } catch (const std::exception& e) {
                spdlog::error("[Indexer] Error embedding text chunk {}: {}", i, e.what());
            }
        }

        files_indexed_++;
        spdlog::info("[Indexer] Indexed {}: {} ({} chunks)", asset_type, path, chunks.size());
        
    } catch (const std::exception& e) {
        spdlog::error("[Indexer] Error processing text {}: {}", path, e.what());
        files_errored_++;
    }
}

// =============================================================================
// Helper Methods
// =============================================================================

std::vector<std::string> Indexer::chunk_text(const std::string& text, 
                                              int chunk_words, 
                                              int overlap_words) 
{
    std::vector<std::string> chunks;
    
    // Split text into words
    std::istringstream iss(text);
    std::vector<std::string> words;
    std::string word;
    
    while (iss >> word) {
        words.push_back(word);
    }

    if (words.empty()) {
        return chunks;
    }

    // Create overlapping chunks
    size_t stride = chunk_words - overlap_words;
    if (stride < 1) stride = 1;

    for (size_t start = 0; start < words.size(); start += stride) {
        size_t end = std::min(start + chunk_words, words.size());
        
        std::ostringstream chunk_stream;
        for (size_t i = start; i < end; ++i) {
            if (i > start) chunk_stream << " ";
            chunk_stream << words[i];
        }
        
        chunks.push_back(chunk_stream.str());
        
        // If this chunk reached the end, break
        if (end >= words.size()) {
            break;
        }
    }

    return chunks;
}

std::string Indexer::extract_pdf_text(const std::string& path) {
    try {
        // Build Python command to extract PDF text
        std::ostringstream cmd;
        cmd << "python -c \"import pdfplumber; ";
        cmd << "pdf = pdfplumber.open(r'" << path << "'); ";
        cmd << "text = '\\n'.join([page.extract_text() or '' for page in pdf.pages]); ";
        cmd << "print(text)\"";

        // Execute subprocess
        FILE* pipe = _popen(cmd.str().c_str(), "r");
        if (!pipe) {
            spdlog::error("[Indexer] Failed to run pdfplumber for: {}", path);
            return "";
        }

        // Read output
        std::ostringstream result;
        char buffer[4096];
        while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
            result << buffer;
        }

        int ret = _pclose(pipe);
        if (ret != 0) {
            spdlog::warn("[Indexer] pdfplumber returned non-zero exit code for: {}", path);
        }

        return result.str();
        
    } catch (const std::exception& e) {
        spdlog::error("[Indexer] Exception in extract_pdf_text: {}", e.what());
        return "";
    }
}

std::string Indexer::transcribe_audio(const std::string& path) {
    try {
        // Build whisper command
        // Note: This assumes whisper-cli or whisper.cpp is in PATH
        // Format: whisper-cli -m <model_path> -f <audio_file> --output-json
        std::ostringstream cmd;
        cmd << "whisper-cli -m models/ggml-base.bin -f \"" << path << "\" --output-json";

        // Execute subprocess
        FILE* pipe = _popen(cmd.str().c_str(), "r");
        if (!pipe) {
            spdlog::error("[Indexer] Failed to run whisper for: {}", path);
            return "";
        }

        // Read output
        std::ostringstream result;
        char buffer[4096];
        while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
            result << buffer;
        }

        _pclose(pipe);

        // Parse JSON output from Whisper
        try {
            json whisper_output = json::parse(result.str());
            
            std::ostringstream transcript;
            if (whisper_output.contains("segments")) {
                for (const auto& segment : whisper_output["segments"]) {
                    if (segment.contains("text")) {
                        transcript << segment["text"].get<std::string>() << " ";
                    }
                }
            } else if (whisper_output.contains("text")) {
                transcript << whisper_output["text"].get<std::string>();
            }
            
            return transcript.str();
            
        } catch (const json::exception& e) {
            spdlog::warn("[Indexer] Failed to parse Whisper JSON output: {}", e.what());
            // Return raw output as fallback
            return result.str();
        }
        
    } catch (const std::exception& e) {
        spdlog::error("[Indexer] Exception in transcribe_audio: {}", e.what());
        return "";
    }
}

} // namespace search
} // namespace omni
