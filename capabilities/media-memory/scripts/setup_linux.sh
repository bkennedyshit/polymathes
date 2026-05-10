#!/bin/bash
set -e

echo "=== OMNI-SEARCH Linux Setup ==="

# CUDA 11.8 Toolkit (matches PyTorch cu118, works on RTX 3090)
echo "Installing CUDA 11.8..."
wget https://developer.download.nvidia.com/compute/cuda/11.8.0/local_installers/cuda-repo-debian11-11-8-local_11.8.0-520.61.05-1_amd64.deb
sudo dpkg -i cuda-repo-debian11-11-8-local_11.8.0-520.61.05-1_amd64.deb
sudo cp /var/cuda-repo-debian11-11-8-local/cuda-*-keyring.gpg /usr/share/keyrings/
sudo add-apt-repository contrib
sudo apt-get update
sudo apt-get -y install cuda
rm cuda-repo-debian11-11-8-local_11.8.0-520.61.05-1_amd64.deb
export PATH=/usr/local/cuda-11.8/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda-11.8/lib64:$LD_LIBRARY_PATH

# System deps
echo "Installing apt dependencies..."
sudo apt-get install -y libsqlite3-dev libopencv-dev libspdlog-dev nlohmann-json3-dev build-essential cmake curl

# ONNX Runtime GPU 1.26.0
echo "Installing ONNX Runtime..."
curl -L -o /tmp/ort.tgz https://github.com/microsoft/onnxruntime/releases/download/v1.26.0/onnxruntime-linux-x64-gpu-1.26.0.tgz
sudo mkdir -p /opt/onnxruntime
sudo tar -xzf /tmp/ort.tgz -C /opt/onnxruntime --strip-components=1
rm /tmp/ort.tgz
export ONNXRUNTIME_ROOT=/opt/onnxruntime

# TensorRT 10.16.1 (CUDA 13.x TAR)
# Download: https://developer.nvidia.com/tensorrt/download/10x
# File: TensorRT-10.16.1.11.Linux.x86_64-gnu.cuda-13.2.tar.gz
# Place in /tmp/ before running this script
TRT_TAR="/tmp/TensorRT-10.16.1.11.Linux.x86_64-gnu.cuda-13.2.tar.gz"
if [ -f "$TRT_TAR" ]; then
    echo "Installing TensorRT..."
    sudo mkdir -p /opt/tensorrt
    sudo tar -xzf "$TRT_TAR" -C /opt/tensorrt --strip-components=1
    export TENSORRT_ROOT=/opt/tensorrt
else
    echo "TensorRT tar not found at $TRT_TAR - skipping (ONNX Runtime fallback will be used)"
    echo "To enable TRT: download TensorRT-10.16.1.11.Linux.x86_64-gnu.cuda-13.2.tar.gz to /tmp/ and re-run"
fi

# Persist env vars
cat >> ~/.bashrc << 'EOF'
export PATH=/usr/local/cuda-11.8/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda-11.8/lib64:$LD_LIBRARY_PATH
export ONNXRUNTIME_ROOT=/opt/onnxruntime
export LD_LIBRARY_PATH=$ONNXRUNTIME_ROOT/lib:$LD_LIBRARY_PATH
export TENSORRT_ROOT=/opt/tensorrt
export LD_LIBRARY_PATH=$TENSORRT_ROOT/lib:$LD_LIBRARY_PATH
EOF

# Build
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$SCRIPT_DIR")"
cmake -B build -DCMAKE_BUILD_TYPE=Release -DOMNI_SEARCH_USE_TENSORRT=ON
cmake --build build -j$(nproc)

echo ""
echo "Done! Binary: $(pwd)/build/omni_search"
echo "Next: python tools/export_model.py --model openclip-vit-l14-336 --validate"