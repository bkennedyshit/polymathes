# Omni-Search Setup Guide

## Prerequisites
1.  **Visual Studio 2022** (with C++ Desktop Development)
2.  **CMake** (3.20+)
3.  **CUDA Toolkit 12.x**
4.  **TensorRT 8.6+**
5.  **OpenCV** (Install via vcpkg or pre-built binaries)

## Step 1: Export the AI Model
We need to convert the PyTorch CLIP model into a format C++ can understand (ONNX).

```powershell
cd tools
pip install torch open_clip_torch onnx
python export_model.py
```
*Output: `models/clip_visual.onnx`*

## Step 2: Optimize for your RTX 3090
Use NVIDIA's `trtexec` to compile the ONNX model into a TensorRT Engine. This makes it run 10x faster.

```powershell
# Assuming TensorRT is in your PATH
trtexec --onnx=../models/clip_visual.onnx --saveEngine=../models/clip_visual.engine --fp16
```
*Output: `models/clip_visual.engine`*

## Step 3: Build the Application
```powershell
cd build
cmake ..
cmake --build . --config Release
```

## Step 4: Run the Indexer
```powershell
./Release/omni_search.exe index "D:/My_Footage"
```

## Step 5: Search (Coming Soon)
The search interface will allow you to query the database created in Step 4.
