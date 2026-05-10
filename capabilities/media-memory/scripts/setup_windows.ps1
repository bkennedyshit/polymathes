$ErrorActionPreference = "Stop"

Write-Host "=== OMNI-SEARCH Windows Setup Script ===" -ForegroundColor Cyan
Write-Host ""

# Check if vcpkg is installed
$vcpkgRoot = $env:VCPKG_ROOT
if (-not $vcpkgRoot) {
    Write-Host "Error: vcpkg not found" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install vcpkg:" -ForegroundColor Yellow
    Write-Host "  1. Clone vcpkg:"
    Write-Host '     git clone https://github.com/Microsoft/vcpkg.git C:\vcpkg'
    Write-Host "  2. Bootstrap vcpkg:"
    Write-Host '     C:\vcpkg\bootstrap-vcpkg.bat'
    Write-Host "  3. Set environment variable:"
    Write-Host '     $env:VCPKG_ROOT = "C:\vcpkg"'
    Write-Host ""
    exit 1
}

Write-Host "✓ vcpkg found at: $vcpkgRoot" -ForegroundColor Green
Write-Host ""

# Install dependencies via vcpkg
Write-Host "Installing dependencies via vcpkg..." -ForegroundColor Yellow
$packages = @(
    "sqlite3:x64-windows",
    "opencv4:x64-windows",
    "spdlog:x64-windows",
    "nlohmann-json:x64-windows"
)

foreach ($pkg in $packages) {
    Write-Host "  Installing $pkg..." -ForegroundColor Cyan
    & "$vcpkgRoot\vcpkg.exe" install $pkg
}

Write-Host "✓ Dependencies installed" -ForegroundColor Green
Write-Host ""

# Download and install ONNX Runtime
Write-Host "Installing ONNX Runtime GPU..." -ForegroundColor Yellow
$onnxVersion = "1.17.1"
$onnxUrl = "https://github.com/microsoft/onnxruntime/releases/download/v$onnxVersion/onnxruntime-win-x64-gpu-$onnxVersion.zip"
$onnxZip = "$env:TEMP\onnxruntime.zip"
$onnxInstallDir = "C:\onnxruntime"

Write-Host "Downloading ONNX Runtime $onnxVersion..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $onnxUrl -OutFile $onnxZip

Write-Host "Extracting to $onnxInstallDir..." -ForegroundColor Cyan
if (Test-Path $onnxInstallDir) {
    Remove-Item -Recurse -Force $onnxInstallDir
}
Expand-Archive -Path $onnxZip -DestinationPath $onnxInstallDir
Remove-Item $onnxZip

# Find the extracted directory and move contents up
$extractedDir = Get-ChildItem -Path $onnxInstallDir -Directory | Select-Object -First 1
if ($extractedDir) {
    Get-ChildItem -Path $extractedDir.FullName | Move-Item -Destination $onnxInstallDir
    Remove-Item -Recurse -Force $extractedDir.FullName
}

$env:ONNXRUNTIME_ROOT = $onnxInstallDir
Write-Host "✓ ONNX Runtime installed to $onnxInstallDir" -ForegroundColor Green
Write-Host ""
Write-Host "Set this environment variable permanently:" -ForegroundColor Yellow
Write-Host "  [System.Environment]::SetEnvironmentVariable('ONNXRUNTIME_ROOT', '$onnxInstallDir', 'User')"
Write-Host ""

# Build the project
Write-Host "Building omni-search..." -ForegroundColor Yellow
$toolchainFile = Join-Path $vcpkgRoot "scripts\buildsystems\vcpkg.cmake"

cmake -B build `
      -DCMAKE_BUILD_TYPE=Release `
      -DCMAKE_TOOLCHAIN_FILE="$toolchainFile"

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
Write-Host "✅ Setup complete!" -ForegroundColor Green
Write-Host ""
$binaryPath = Join-Path (Get-Location) "build\Release\omni-search.exe"
Write-Host "Binary location: $binaryPath" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Place your ONNX models in the models\ directory"
Write-Host "  2. Convert ONNX models to TensorRT engines (if using TensorRT):"
Write-Host "     .\tools\build_engines.ps1"
Write-Host "  3. Run the indexer:"
Write-Host "     .\build\Release\omni-search.exe index C:\path\to\data"
Write-Host "  4. Start searching:"
Write-Host "     .\build\Release\omni-search.exe search"
Write-Host ""
