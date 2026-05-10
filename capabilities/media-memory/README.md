# media-memory

**Semantic search and retrieval over images, video, audio, documents, and code.** The visual/media memory layer of [Polymath](../../README.md).

This is a Polymath capability. It can run standalone as a CLI or as an MCP server that Polymath Core calls into.

---

## Status

**Functional.** C++17 implementation with CUDA/TensorRT acceleration. Builds on Windows (MSVC + vcpkg) and Linux (GCC/Clang + apt).

## What it does

Indexes any directory of mixed media into a local SQLite vector database, then answers queries by cosine similarity over CLIP embeddings.

Supported formats:

| Type | Extensions |
|---|---|
| Images | `.jpg .jpeg .png .webp .bmp` |
| Video | `.mp4 .mov .mkv .avi` (frame extraction every N seconds) |
| Audio | `.wav .mp3 .flac .m4a` (via Whisper transcription) |
| Documents | `.txt .md .pdf` |
| Code | `.cpp .h .hpp .py .js .ts .rs .go .java` |

Backend auto-selects TensorRT `.engine` files if present, falls back to ONNX Runtime GPU, then CPU.

## Two ways to use it

### 1. Standalone CLI (end-user mode)

```bash
# Index a directory
omni_search index ~/Videos

# Text search
omni_search search "red car at sunset"

# Reverse image search
omni_search search --image ./reference.jpg

# Interactive RAG chat (uses llama.cpp if configured)
omni_search chat
```

### 2. Polymath capability (agent mode)

When invoked with `--mcp-stdio`, the binary becomes an MCP server speaking the Model Context Protocol over stdin/stdout. Polymath Core spawns it as a subprocess and calls its tools.

```bash
omni_search --mcp-stdio
# Runs silently, expects MCP JSON-RPC on stdin/stdout
```

Tools exposed:

- `media_index(path, frame_interval?, force?, exclude?)` — index a directory
- `media_search(query, top_k?, min_score?, type_filter?)` — natural-language search
- `media_search_by_image(image_path, top_k?)` — reverse visual search
- `media_describe(id)` — fetch full record for an asset

Polymath config entry:

```toml
[[capabilities]]
name = "media-memory"
command = "/path/to/omni_search"
args = ["--mcp-stdio"]
env = { OMNI_SEARCH_DB = "~/.omni-search/index.db" }
```

## Build

See [`DESIGN.md`](DESIGN.md) for architecture and [`SETUP.md`](SETUP.md) for detailed setup. TL;DR:

**Windows:**
```powershell
.\scripts\setup_windows.ps1
# Then export model and build engines:
cd tools
python export_model.py --model openclip-vit-l14-336 --validate
.\build_engines.ps1
```

**Linux:**
```bash
bash scripts/setup_linux.sh
# Then:
cd tools
python export_model.py --model openclip-vit-l14-336 --validate
bash build_engines.sh
```

## Dependencies

- CUDA 11.8 toolkit (matches PyTorch cu118 — RTX 3090 + 4090 + 5090 supported)
- ONNX Runtime GPU 1.26.0 C++ SDK
- TensorRT 10.16.1 (optional but recommended on NVIDIA)
- vcpkg (Windows) / apt (Linux) for OpenCV, SQLite3, spdlog, nlohmann-json

## Performance

| Task | RTX 3090 + TensorRT FP16 | CPU + ONNX Runtime |
|---|---|---|
| Image embedding | ~2 ms | ~50 ms |
| Text embedding | ~1 ms | ~30 ms |
| 1000 images indexed | ~10 s | ~2 min |
| Search 100K vectors | ~50 ms | ~50 ms |

## Why C++ instead of Python

Python with ONNX Runtime works, but:

1. Indexing 10,000 frames at 2ms each is 20 seconds of pure GPU time. Python's per-call overhead and GIL pushes that to 60-100 seconds.
2. Shipping a single binary vs a Python environment matters for "drop it on a workstation and go."
3. Polymath's other hot-path capabilities (virtual-input at 30fps, future video analysis) share the same constraint, so the language decision is made once.

## Model selection

| Model | Image Size | Embed Dim | Best For |
|---|---|---|---|
| `clip-vit-b32` | 224 | 512 | Fast, general purpose |
| `clip-vit-l14` | 224 | 768 | Balanced quality |
| **`openclip-vit-l14-336`** | 336 | 768 | **Best zero-shot (default)** |
| `siglip-400m` | 224 | 1152 | Highest quality |

## See also

- [`DESIGN.md`](DESIGN.md) — full architecture
- [`SETUP.md`](SETUP.md) — dependency install walkthrough
- [`.kiro/specs/media-memory-completion/`](../../.kiro/specs/media-memory-completion/) — implementation spec
