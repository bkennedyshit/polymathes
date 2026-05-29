# Omni-Search (media-memory) Setup Guide

The C++ CLIP indexer that powers Polymath's `media.vision_search`.
Vision search is **optional** — Polymath runs fine without it (you just
lose visual similarity search over videos/photos). Set this up only if
you want that capability.

## Prerequisites

1. **Visual Studio 2022** (with C++ Desktop Development workload)
2. **CMake** 3.20+
3. **CUDA Toolkit 11.8** (matches the prebuilt ONNX Runtime GPU below)
4. **ONNX Runtime GPU 1.26** — https://github.com/microsoft/onnxruntime/releases
5. **TensorRT 10.x** (optional — only if you want the FP16 fast path)
6. **OpenCV** (via vcpkg or prebuilt binaries)
7. **Python 3.11+** with `torch`, `open_clip_torch`, `onnx`, `onnxscript`
   (for the one-time model export)

## Step 1: Export the CLIP model to ONNX

The binary loads `image_encoder.onnx` + `text_encoder.onnx`. Use the
dynamo exporter (works with PyTorch 2.6+; the legacy `export_model.py`
path fails on `aten::_native_multi_head_attention`):

```powershell
cd tools
pip install torch open_clip_torch onnx onnxscript
python export_dynamo.py
```

Output (written to `../models/`):
- `image_encoder.onnx` (+ `image_encoder.onnx.data`)
- `text_encoder.onnx` (+ `text_encoder.onnx.data`)
- `tokenizer/vocab.json`, `tokenizer/merges.txt`
- `model_config.json`

> The model files are gitignored (large binaries). Every user runs this
> export once after cloning.

## Step 2 (optional): TensorRT engines for the FP16 fast path

```powershell
$env:PATH = "C:\path\to\TensorRT\lib;" + $env:PATH
trtexec --onnx=models\image_encoder.onnx --saveEngine=models\image_encoder.engine --fp16
trtexec --onnx=models\text_encoder.onnx  --saveEngine=models\text_encoder.engine  --fp16
```

Note: FP16 trades a little ranking precision for ~10x speed. For small
catalogs the ONNX FP32 path (no engines) gives sharper similarity
scores — only build engines if you have a large library and care about
indexing throughput. The binary auto-detects engines in `models/`; if
absent it falls back to ONNX Runtime.

## Step 3: Build the binary

```powershell
mkdir build; cd build
cmake .. -DONNXRUNTIME_INCLUDE_DIR=<path> -DONNXRUNTIME_LIBRARY=<path>\onnxruntime.lib
cmake --build . --config Release
```

Output: `build/Release/omni_search.exe`

## Step 4: Configure `~/.omni-search/config.json`

The binary reads its config from `~/.omni-search/config.json`. Use
**absolute** paths so it works regardless of working directory:

```json
{
  "clip_model": "openclip-vit-l14-336",
  "model_dir": "C:/path/to/polymath/capabilities/media-memory/models/",
  "db_path": "C:/Users/<you>/.omni-search/omni_index.db",
  "use_tensorrt": false,
  "min_score": 0.1,
  "frame_interval": 2.0
}
```

> `min_score: 0.1` matters for text→image queries: CLIP text-to-video
> similarity scores are typically 0.15–0.25, so the default 0.25
> threshold would filter everything out.

## Step 5: Index, then wire into Polymath

```powershell
# Index a directory (CLI mode)
.\build\Release\omni_search.exe index "D:\Content\reels"
```

Register the server in `~/.polymath/polymath.json` so Polymath's
`media.vision_search` can reach it (note: JSON, an `mcp_servers` array):

```json
{
  "mcp_servers": [
    {
      "name": "media-memory",
      "command": "C:/path/to/omni_search.exe",
      "args": ["--mcp-stdio"]
    }
  ]
}
```

Then from Polymath:

```powershell
polymath media vision-index "D:\Content\reels"   # index via the gateway
# ...or ask the agent: "find me a reel showing a bunny hop"
```

The C++ index lives in `~/.omni-search/omni_index.db`; Polymath's own
catalog lives in `~/.polymath/`. `media.vision_search` joins hits back
to the Polymath catalog by file path — index the same paths you seeded
with `polymath media seed` so the metadata join lines up.
