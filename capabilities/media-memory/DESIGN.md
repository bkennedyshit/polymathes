# Omni-Search: Local AI Search Engine
## "The ChatRTX Killer"

### Overview
A local, privacy-first search engine for **all** your digital assets (Images, Videos, Documents, Code).
Built using the high-performance primitives from `omni-repo` (C++/CUDA) but orchestrated for end-user utility.

### Architecture
We are replacing the bloated ChatRTX stack with our own optimized components:

| Component | ChatRTX (Theirs) | Omni-Search (Ours) | Source |
| :--- | :--- | :--- | :--- |
| **Inference** | TensorRT-LLM (Python Wrapper) | `omni::ml::inference::TensorRTEngine` | `omni_ai_ml` |
| **Vision** | CLIP (PyTorch) | `omni::vision::CLIP` (Custom C++ impl) | `omni_ai_ml` |
| **Video** | Ignored / None | `omni::video::FrameExtractor` | `omni_video_editing` |
| **Audio** | Whisper (Python) | `omni::audio::Whisper` (C++ Port) | `omni_audio_production` |
| **Storage** | LlamaIndex (Python) | `omni::core::VectorDB` | `omni_ai_ml` |

### Core Features
1.  **Universal Indexing**:
    *   **Images**: Semantic search ("red car").
    *   **Video**: Semantic search at frame level ("jump at 00:42").
    *   **Audio**: Vibe/Content search ("upbeat music", "voiceover").
    *   **Documents**: RAG (Retrieval Augmented Generation) for PDFs/Txt.

2.  **Zero-Latency**:
    *   Everything runs on the local RTX GPU.
    *   No API calls, no cloud, no monthly fees.

3.  **Business Integration**:
    *   Directly pipe results into editing workflows (Premiere/DaVinci).
    *   Auto-tagging for asset management.

### Directory Structure
```
omni-search/
├── src/
│   ├── indexer/        # The "Crawler" (C++)
│   ├── search/         # The "Query Engine" (C++)
│   ├── api/            # Local REST API (for UI/CLI)
│   └── main.cpp        # Entry point
├── include/            # Headers
├── models/             # TRT Engines (CLIP, Whisper, BERT)
└── db/                 # Vector Database storage
```

### Build Strategy
We will link against the static libraries built in `omni-repo`:
*   `omni_ai_ml.lib`
*   `omni_video_editing.lib`
*   `omni_audio_production.lib`

This ensures we reuse the "LEGO blocks" we've already perfected, rather than rewriting them.
