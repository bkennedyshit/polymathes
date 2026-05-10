# WSL Sandbox Backend

## Prerequisites

Windows 10/11 with WSL2 enabled.

## Setup

1. Install WSL if not already present:
   ```powershell
   wsl --install
   ```

2. Import or create the `polymath-sbx` distro:
   ```powershell
   # Option A: Import from a tar
   wsl --import polymath-sbx C:\wsl\polymath-sbx .\ubuntu-22.04.tar

   # Option B: Duplicate an existing distro
   wsl --export Ubuntu ubuntu-export.tar
   wsl --import polymath-sbx C:\wsl\polymath-sbx ubuntu-export.tar
   ```

3. Verify:
   ```powershell
   wsl -d polymath-sbx -- echo "ready"
   ```

## How it works

Commands run via `wsl.exe -d polymath-sbx -- sh -c <command>`. The backend:
- Checks `C:\Windows\System32\wsl.exe` exists (Windows only)
- Falls back gracefully with an error if WSL is unavailable
- Supports `AbortSignal` for timeout/cancellation

## Limitations

- Windows only
- Shares the host filesystem by default (WSL mounts Windows drives at `/mnt/c/`)
- No network isolation unless configured inside the distro
