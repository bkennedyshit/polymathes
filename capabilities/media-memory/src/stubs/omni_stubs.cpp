// Stub implementations for when OMNI_SEARCH_USE_OMNI_REPO is OFF
// This file provides minimal stubs so the build succeeds without omni-repo

#ifndef OMNI_SEARCH_USE_OMNI_REPO

#include <spdlog/spdlog.h>

namespace omni {
namespace ml {
namespace inference {

// Stub TensorRT engine class
class TensorRTEngine {
public:
    TensorRTEngine() {
        spdlog::warn("omni-repo not available - using ONNX Runtime fallback only");
    }
    
    bool is_available() const { return false; }
};

}  // namespace inference
}  // namespace ml

namespace video {

// Stub frame extractor
class FrameExtractor {
public:
    FrameExtractor() {
        spdlog::debug("Using OpenCV for video frame extraction (omni-repo not available)");
    }
};

}  // namespace video

namespace audio {

// Stub audio processor
class Whisper {
public:
    Whisper() {
        spdlog::debug("Using subprocess Whisper (omni-repo not available)");
    }
};

}  // namespace audio

}  // namespace omni

#endif  // !OMNI_SEARCH_USE_OMNI_REPO
