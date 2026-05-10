#pragma once

#include <string>
#include <vector>
#include <memory>
#include <map>
#include <opencv2/core.hpp>
#include "omni/search/bpe_tokenizer.hpp"

// Forward declarations for ONNX Runtime
namespace Ort {
    class Env;
    class Session;
    class SessionOptions;
}

#ifdef OMNI_SEARCH_USE_TRT
namespace nvinfer1 {
    class IRuntime;
    class ICudaEngine;
    class IExecutionContext;
}
#endif

namespace omni {
namespace search {

struct EmbeddingEngineConfig {
    std::string model_dir;
    std::string clip_model;
    int embed_dim = 512;
    int image_size = 224;
    bool use_trt = false;
};

class EmbeddingEngine {
public:
    using Config = EmbeddingEngineConfig;

    explicit EmbeddingEngine(const Config& config);
    ~EmbeddingEngine();

    std::vector<float> embed_image(const cv::Mat& bgr_image);
    std::vector<float> embed_text(const std::string& text);
    int embedding_dim() const { return embed_dim_; }

private:
    struct ModelConfig {
        int image_size;
        int embed_dim;
        int context_length;
    };

    void init_model_config();
    void load_onnx_models();

#ifdef OMNI_SEARCH_USE_TRT
    bool try_load_trt_engines();
    std::vector<float> run_trt_image_inference(const cv::Mat& preprocessed);
    std::vector<float> run_trt_text_inference(const std::vector<int32_t>& tokens);
#endif

    std::vector<float> run_onnx_image_inference(const cv::Mat& preprocessed);
    std::vector<float> run_onnx_text_inference(const std::vector<int32_t>& tokens);
    cv::Mat preprocess_image(const cv::Mat& bgr_image);
    static void l2_normalize(std::vector<float>& vec);
    static const std::map<std::string, ModelConfig>& get_model_configs();

    Config config_;
    int embed_dim_;
    int image_size_;
    int context_length_;

    std::unique_ptr<Ort::Env> ort_env_;
    std::unique_ptr<Ort::Session> image_session_;
    std::unique_ptr<Ort::Session> text_session_;

#ifdef OMNI_SEARCH_USE_TRT
    std::unique_ptr<nvinfer1::IRuntime> trt_runtime_;
    std::unique_ptr<nvinfer1::ICudaEngine> image_engine_;
    std::unique_ptr<nvinfer1::ICudaEngine> text_engine_;
    std::unique_ptr<nvinfer1::IExecutionContext> image_context_;
    std::unique_ptr<nvinfer1::IExecutionContext> text_context_;
    void* cuda_buffers_[4] = {nullptr};
#endif

    bool using_trt_ = false;

    std::unique_ptr<BPETokenizer> tokenizer_;
};

} // namespace search
} // namespace omni