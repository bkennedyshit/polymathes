#include "omni/search/embedding_engine.hpp"
#include "omni/search/bpe_tokenizer.hpp"

#include <spdlog/spdlog.h>
#include <opencv2/imgproc.hpp>
#include <onnxruntime_cxx_api.h>

#include <fstream>
#include <cmath>
#include <algorithm>
#include <stdexcept>

#ifdef OMNI_SEARCH_USE_TRT
#include <NvInfer.h>
#include <NvOnnxParser.h>
#include <cuda_runtime_api.h>

// Minimal TensorRT ILogger adapter that forwards to spdlog
class TrtLogger : public nvinfer1::ILogger {
public:
    void log(Severity severity, const char* msg) noexcept override {
        switch (severity) {
            case Severity::kERROR:   spdlog::error("[TRT] {}", msg); break;
            case Severity::kWARNING: spdlog::warn("[TRT] {}", msg); break;
            case Severity::kINFO:    spdlog::debug("[TRT] {}", msg); break;
            default: break;
        }
    }
};
static TrtLogger g_trt_logger;
#endif

namespace omni {
namespace search {

namespace {

// OpenCLIP normalization constants
constexpr float OPENCLIP_MEAN[3] = {0.48145466f, 0.4578275f, 0.40821073f};
constexpr float OPENCLIP_STD[3] = {0.26862954f, 0.26130258f, 0.27577711f};

} // anonymous namespace

const std::map<std::string, EmbeddingEngine::ModelConfig>& EmbeddingEngine::get_model_configs() {
    static const std::map<std::string, ModelConfig> configs = {
        {"clip-vit-b32", {224, 512, 77}},
        {"clip-vit-l14", {224, 768, 77}},
        {"openclip-vit-l14-336", {336, 768, 77}},
        {"siglip-400m", {224, 1152, 77}}
    };
    return configs;
}

EmbeddingEngine::EmbeddingEngine(const Config& config)
    : config_(config)
    , embed_dim_(config.embed_dim)
    , image_size_(config.image_size)
    , context_length_(77)
{
    spdlog::info("Initializing EmbeddingEngine with model: {}", config_.clip_model);

    // Initialize model configuration
    init_model_config();

    // Initialize ONNX Runtime environment
    ort_env_ = std::make_unique<Ort::Env>(ORT_LOGGING_LEVEL_WARNING, "omni-search");

    // Try to load TensorRT engines if requested
#ifdef OMNI_SEARCH_USE_TRT
    if (config_.use_trt) {
        if (try_load_trt_engines()) {
            using_trt_ = true;
            spdlog::info("Successfully loaded TensorRT engines");
        } else {
            spdlog::warn("TensorRT engine loading failed, falling back to ONNX Runtime");
            using_trt_ = false;
        }
    }
#else
    if (config_.use_trt) {
        spdlog::warn("TensorRT support not compiled, using ONNX Runtime");
    }
#endif

    // Load ONNX models if not using TensorRT
    if (!using_trt_) {
        load_onnx_models();
        spdlog::info("Successfully loaded ONNX Runtime models");
    }

    // Initialize BPE tokenizer
    tokenizer_ = std::make_unique<BPETokenizer>(config_.model_dir);
    spdlog::info("Embedding engine initialized successfully");
}

EmbeddingEngine::~EmbeddingEngine() {
#ifdef OMNI_SEARCH_USE_TRT
    // Clean up CUDA buffers
    for (int i = 0; i < 4; ++i) {
        if (cuda_buffers_[i]) {
            cudaFree(cuda_buffers_[i]);
        }
    }
#endif
}

void EmbeddingEngine::init_model_config() {
    const auto& configs = get_model_configs();
    auto it = configs.find(config_.clip_model);
    
    if (it == configs.end()) {
        throw std::runtime_error("Unknown model: " + config_.clip_model);
    }

    const auto& model_config = it->second;
    embed_dim_ = model_config.embed_dim;
    image_size_ = model_config.image_size;
    context_length_ = model_config.context_length;

    spdlog::debug("Model config: image_size={}, embed_dim={}, context_length={}",
                  image_size_, embed_dim_, context_length_);
}

void EmbeddingEngine::load_onnx_models() {
    Ort::SessionOptions session_options;
    session_options.SetIntraOpNumThreads(4);
    session_options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);

    // Load image encoder
    std::string image_model_path = config_.model_dir + "/image_encoder.onnx";
    spdlog::debug("Loading image encoder from: {}", image_model_path);
    
#ifdef _WIN32
    std::wstring image_model_path_w(image_model_path.begin(), image_model_path.end());
    image_session_ = std::make_unique<Ort::Session>(*ort_env_, image_model_path_w.c_str(), session_options);
#else
    image_session_ = std::make_unique<Ort::Session>(*ort_env_, image_model_path.c_str(), session_options);
#endif

    // Load text encoder
    std::string text_model_path = config_.model_dir + "/text_encoder.onnx";
    spdlog::debug("Loading text encoder from: {}", text_model_path);
    
#ifdef _WIN32
    std::wstring text_model_path_w(text_model_path.begin(), text_model_path.end());
    text_session_ = std::make_unique<Ort::Session>(*ort_env_, text_model_path_w.c_str(), session_options);
#else
    text_session_ = std::make_unique<Ort::Session>(*ort_env_, text_model_path.c_str(), session_options);
#endif
}

#ifdef OMNI_SEARCH_USE_TRT
bool EmbeddingEngine::try_load_trt_engines() {
    std::string image_engine_path = config_.model_dir + "/image_encoder.engine";
    std::string text_engine_path = config_.model_dir + "/text_encoder.engine";

    // Check if engine files exist
    std::ifstream image_file(image_engine_path, std::ios::binary);
    std::ifstream text_file(text_engine_path, std::ios::binary);
    
    if (!image_file.good() || !text_file.good()) {
        spdlog::warn("TensorRT engine files not found");
        return false;
    }

    try {
        // Create TensorRT runtime
        trt_runtime_.reset(nvinfer1::createInferRuntime(g_trt_logger));
        
        // Load image engine
        image_file.seekg(0, std::ios::end);
        size_t image_size = image_file.tellg();
        image_file.seekg(0, std::ios::beg);
        std::vector<char> image_data(image_size);
        image_file.read(image_data.data(), image_size);
        
        image_engine_.reset(trt_runtime_->deserializeCudaEngine(image_data.data(), image_size));
        if (!image_engine_) {
            spdlog::error("Failed to deserialize image TensorRT engine");
            return false;
        }
        image_context_.reset(image_engine_->createExecutionContext());

        // Load text engine
        text_file.seekg(0, std::ios::end);
        size_t text_size = text_file.tellg();
        text_file.seekg(0, std::ios::beg);
        std::vector<char> text_data(text_size);
        text_file.read(text_data.data(), text_size);
        
        text_engine_.reset(trt_runtime_->deserializeCudaEngine(text_data.data(), text_size));
        if (!text_engine_) {
            spdlog::error("Failed to deserialize text TensorRT engine");
            return false;
        }
        text_context_.reset(text_engine_->createExecutionContext());

        // Allocate CUDA buffers
        size_t image_input_size = 1 * 3 * image_size_ * image_size_ * sizeof(float);
        size_t image_output_size = 1 * embed_dim_ * sizeof(float);
        cudaMalloc(&cuda_buffers_[0], image_input_size);
        cudaMalloc(&cuda_buffers_[1], image_output_size);

        size_t text_input_size = 1 * context_length_ * sizeof(int32_t);
        size_t text_output_size = 1 * embed_dim_ * sizeof(float);
        cudaMalloc(&cuda_buffers_[2], text_input_size);
        cudaMalloc(&cuda_buffers_[3], text_output_size);

        return true;
    } catch (const std::exception& e) {
        spdlog::error("TensorRT initialization failed: {}", e.what());
        return false;
    }
}

std::vector<float> EmbeddingEngine::run_trt_image_inference(const cv::Mat& preprocessed) {
    // Copy input to GPU
    std::vector<float> input_data(preprocessed.total() * preprocessed.channels());
    std::memcpy(input_data.data(), preprocessed.data, input_data.size() * sizeof(float));
    cudaMemcpy(cuda_buffers_[0], input_data.data(), input_data.size() * sizeof(float), cudaMemcpyHostToDevice);

    // Run inference
    void* bindings[] = {cuda_buffers_[0], cuda_buffers_[1]};
    image_context_->executeV2(bindings);

    // Copy output from GPU
    std::vector<float> output(embed_dim_);
    cudaMemcpy(output.data(), cuda_buffers_[1], embed_dim_ * sizeof(float), cudaMemcpyDeviceToHost);

    return output;
}

std::vector<float> EmbeddingEngine::run_trt_text_inference(const std::vector<int32_t>& tokens) {
    // Copy input to GPU
    cudaMemcpy(cuda_buffers_[2], tokens.data(), tokens.size() * sizeof(int32_t), cudaMemcpyHostToDevice);

    // Run inference
    void* bindings[] = {cuda_buffers_[2], cuda_buffers_[3]};
    text_context_->executeV2(bindings);

    // Copy output from GPU
    std::vector<float> output(embed_dim_);
    cudaMemcpy(output.data(), cuda_buffers_[3], embed_dim_ * sizeof(float), cudaMemcpyDeviceToHost);

    return output;
}
#endif

std::vector<float> EmbeddingEngine::run_onnx_image_inference(const cv::Mat& preprocessed) {
    // Prepare input tensor
    auto memory_info = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    std::vector<int64_t> input_shape = {1, 3, image_size_, image_size_};
    
    std::vector<float> input_data(preprocessed.total() * preprocessed.channels());
    std::memcpy(input_data.data(), preprocessed.data, input_data.size() * sizeof(float));

    Ort::Value input_tensor = Ort::Value::CreateTensor<float>(
        memory_info, input_data.data(), input_data.size(),
        input_shape.data(), input_shape.size()
    );

    // Get input/output names
    Ort::AllocatorWithDefaultOptions allocator;
    auto input_name = image_session_->GetInputNameAllocated(0, allocator);
    auto output_name = image_session_->GetOutputNameAllocated(0, allocator);
    
    const char* input_names[] = {input_name.get()};
    const char* output_names[] = {output_name.get()};

    // Run inference
    auto output_tensors = image_session_->Run(
        Ort::RunOptions{nullptr},
        input_names, &input_tensor, 1,
        output_names, 1
    );

    // Extract output
    float* output_data = output_tensors[0].GetTensorMutableData<float>();
    std::vector<float> output(output_data, output_data + embed_dim_);

    return output;
}

std::vector<float> EmbeddingEngine::run_onnx_text_inference(const std::vector<int32_t>& tokens) {
    // Prepare input tensor
    auto memory_info = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    std::vector<int64_t> input_shape = {1, static_cast<int64_t>(tokens.size())};
    
    std::vector<int64_t> input_data(tokens.begin(), tokens.end());

    Ort::Value input_tensor = Ort::Value::CreateTensor<int64_t>(
        memory_info, input_data.data(), input_data.size(),
        input_shape.data(), input_shape.size()
    );

    // Get input/output names
    Ort::AllocatorWithDefaultOptions allocator;
    auto input_name = text_session_->GetInputNameAllocated(0, allocator);
    auto output_name = text_session_->GetOutputNameAllocated(0, allocator);
    
    const char* input_names[] = {input_name.get()};
    const char* output_names[] = {output_name.get()};

    // Run inference
    auto output_tensors = text_session_->Run(
        Ort::RunOptions{nullptr},
        input_names, &input_tensor, 1,
        output_names, 1
    );

    // Extract output
    float* output_data = output_tensors[0].GetTensorMutableData<float>();
    std::vector<float> output(output_data, output_data + embed_dim_);

    return output;
}

cv::Mat EmbeddingEngine::preprocess_image(const cv::Mat& bgr_image) {
    cv::Mat resized, rgb, float_image;
    
    // Resize to model input size
    cv::resize(bgr_image, resized, cv::Size(image_size_, image_size_), 0, 0, cv::INTER_LINEAR);
    
    // Convert BGR to RGB
    cv::cvtColor(resized, rgb, cv::COLOR_BGR2RGB);
    
    // Convert to float32 and normalize to [0, 1]
    rgb.convertTo(float_image, CV_32F, 1.0 / 255.0);
    
    // Apply OpenCLIP normalization (per-channel mean and std)
    std::vector<cv::Mat> channels(3);
    cv::split(float_image, channels);
    
    for (int c = 0; c < 3; ++c) {
        channels[c] = (channels[c] - OPENCLIP_MEAN[c]) / OPENCLIP_STD[c];
    }
    
    cv::merge(channels, float_image);
    
    // Convert HWC to CHW layout
    cv::Mat chw(image_size_ * 3, image_size_, CV_32F);
    for (int c = 0; c < 3; ++c) {
        cv::Mat channel = chw.rowRange(c * image_size_, (c + 1) * image_size_);
        cv::extractChannel(float_image, channel, c);
    }
    
    return chw;
}

void EmbeddingEngine::l2_normalize(std::vector<float>& vec) {
    float norm = 0.0f;
    for (float val : vec) {
        norm += val * val;
    }
    norm = std::sqrt(norm);
    
    // Handle zero vector case
    if (norm < 1e-12f) {
        spdlog::warn("Zero vector encountered during L2 normalization");
        return;
    }
    
    for (float& val : vec) {
        val /= norm;
    }
}

std::vector<float> EmbeddingEngine::embed_image(const cv::Mat& bgr_image) {
    // Preprocess image
    cv::Mat preprocessed = preprocess_image(bgr_image);
    
    // Run inference
    std::vector<float> embedding;
    
#ifdef OMNI_SEARCH_USE_TRT
    if (using_trt_) {
        embedding = run_trt_image_inference(preprocessed);
    } else {
        embedding = run_onnx_image_inference(preprocessed);
    }
#else
    embedding = run_onnx_image_inference(preprocessed);
#endif
    
    // L2 normalize
    l2_normalize(embedding);
    
    return embedding;
}

std::vector<float> EmbeddingEngine::embed_text(const std::string& text) {
    // Tokenize text
    std::vector<int32_t> tokens = tokenizer_->tokenize(text, context_length_);
    
    // Run inference
    std::vector<float> embedding;
    
#ifdef OMNI_SEARCH_USE_TRT
    if (using_trt_) {
        embedding = run_trt_text_inference(tokens);
    } else {
        embedding = run_onnx_text_inference(tokens);
    }
#else
    embedding = run_onnx_text_inference(tokens);
#endif
    
    // L2 normalize
    l2_normalize(embedding);
    
    return embedding;
}

} // namespace search
} // namespace omni
