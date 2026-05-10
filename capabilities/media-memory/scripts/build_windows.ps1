$ErrorActionPreference = "Stop"

Write-Host "=== Building omni-search (Windows) ===" -ForegroundColor Cyan

cmake -B build -DCMAKE_BUILD_TYPE=Release

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: CMake configuration failed" -ForegroundColor Red
    exit 1
}

cmake --build build --config Release

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: Build failed" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "✅ Build complete!" -ForegroundColor Green
$binaryPath = Join-Path (Get-Location) "build\Release\omni-search.exe"
Write-Host "Binary: $binaryPath" -ForegroundColor Cyan
