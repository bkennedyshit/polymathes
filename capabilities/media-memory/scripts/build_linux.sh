#!/bin/bash
set -e

echo "=== Building omni-search (Linux) ==="

cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)

echo ""
echo "✅ Build complete!"
echo "Binary: $(pwd)/build/omni-search"
