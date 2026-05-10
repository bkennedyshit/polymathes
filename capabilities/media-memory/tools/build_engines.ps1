$ErrorActionPreference = "Stop"

Write-Host "=== OMNI-SEARCH TensorRT Engine Builder (Windows) ===" -ForegroundColor Cyan

# Check if TENSORRT_ROOT is set
if (-not $env:TENSORRT_ROOT) {
    Write-Host "Error: TENSORRT_ROOT environment variable is not set" -ForegroundColor Red
    Write-Host "Please set it to your TensorRT installation directory, e.g.:"
    Write-Host '  $env:TENSORRT_ROOT = "C:\TensorRT"' -ForegroundColor Yellow
    exit 1
}

# Find trtexec.exe
$trtexec = Join-Path $env:TENSORRT_ROOT "bin\trtexec.exe"
if (-not (Test-Path $trtexec)) {
    Write-Host "Error: trtexec.exe not found at: $trtexec" -ForegroundColor Red
    Write-Host "Please verify your TensorRT installation." -ForegroundColor Yellow
    exit 1
}

Write-Host "✓ TensorRT found at: $env:TENSORRT_ROOT" -ForegroundColor Green
Write-Host "✓ trtexec found at: $trtexec" -ForegroundColor Green

# Create models directory if it doesn't exist
if (-not (Test-Path "models")) {
    New-Item -ItemType Directory -Path "models" | Out-Null
}

Write-Host ""
Write-Host "Converting clip_visual.onnx to TensorRT engine..." -ForegroundColor Yellow
& $trtexec --onnx=models\clip_visual.onnx `
           --saveEngine=models\clip_visual.engine `
           --fp16 `
           --verbose

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: Failed to convert clip_visual.onnx" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Converting clip_text.onnx to TensorRT engine..." -ForegroundColor Yellow
& $trtexec --onnx=models\clip_text.onnx `
           --saveEngine=models\clip_text.engine `
           --fp16 `
           --verbose

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: Failed to convert clip_text.onnx" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "✅ Engine conversion complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Generated files:" -ForegroundColor Cyan
Get-ChildItem models\*.engine | ForEach-Object {
    $size = "{0:N2} MB" -f ($_.Length / 1MB)
    Write-Host "  $($_.Name) ($size)"
}
Write-Host ""
Write-Host "Engines are ready for use with omni-search." -ForegroundColor Green
