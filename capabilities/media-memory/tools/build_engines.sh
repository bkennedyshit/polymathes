#!/bin/bash
set -e

echo "=== OMNI-SEARCH TensorRT Engine Builder (Linux) ==="

# Check if TENSORRT_ROOT is set
if [ -z "$TENSORRT_ROOT" ]; then
    echo "Error: TENSORRT_ROOT environment variable is not set"
    echo "Please set it to your TensorRT installation directory, e.g.:"
    echo "  export TENSORRT_ROOT=/usr/local/TensorRT"
    exit 1
fi

# Check if trtexec is on PATH
if ! command -v trtexec &> /dev/null; then
    echo "Error: trtexec not found on PATH"
    echo "Please add \$TENSORRT_ROOT/bin to your PATH:"
    echo "  export PATH=\$TENSORRT_ROOT/bin:\$PATH"
    exit 1
fi

echo "✓ TensorRT found at: $TENSORRT_ROOT"
echo "✓ trtexec found at: $(which trtexec)"

# Create models directory if it doesn't exist
mkdir -p models

echo ""
echo "Converting clip_visual.onnx to TensorRT engine..."
trtexec --onnx=models/clip_visual.onnx \
        --saveEngine=models/clip_visual.engine \
        --fp16 \
        --verbose

echo ""
echo "Converting clip_text.onnx to TensorRT engine..."
trtexec --onnx=models/clip_text.onnx \
        --saveEngine=models/clip_text.engine \
        --fp16 \
        --verbose

echo ""
echo "✅ Engine conversion complete!"
echo ""
echo "Generated files:"
ls -lh models/*.engine | awk '{print "  " $9 " (" $5 ")"}'
echo ""
echo "Engines are ready for use with omni-search."
