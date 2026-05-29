"""Optional bridge to the polymathes CUDA + TensorRT C++ engine.

When ``MNEME_NATIVE_BIN`` (or ``Config.native_bin``) points at a built
``media-memory`` / ``omni-search`` binary, Mneme can delegate the heavy lifting
to it instead of the pure-Python path. This is the "power user / demo" tier:
same tool surface, TensorRT FP16 speed.

The binary already speaks MCP over stdio (``--mcp-stdio``) and exposes a CLI
(``index`` / ``search`` / ``search --image``). We use the CLI here because it
keeps this bridge transport-agnostic and easy to reason about.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Optional


def resolve_binary(native_bin: Optional[str]) -> Optional[str]:
    """Return a usable path to the native binary, or None."""
    if native_bin:
        p = Path(native_bin).expanduser()
        if p.exists() and p.is_file():
            return str(p)
    # Fall back to PATH lookups under common names.
    for name in ("omni-search", "media-memory", "mediamemory"):
        found = shutil.which(name)
        if found:
            return found
    return None


def available(native_bin: Optional[str]) -> bool:
    return resolve_binary(native_bin) is not None


def native_index(binary: str, path: str, *, force: bool = False,
                 db_path: Optional[str] = None, timeout: int = 3600) -> str:
    cmd = [binary, "index", path]
    if db_path:
        cmd += ["--db-path", db_path]
    if force:
        cmd += ["--force-reindex"]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"native index failed: {proc.stderr.strip()[:500]}")
    return proc.stdout.strip()


def native_search(binary: str, query: str, *, top_k: int = 10,
                  db_path: Optional[str] = None, timeout: int = 120) -> str:
    cmd = [binary, "search", query, "--top-k", str(top_k)]
    if db_path:
        cmd += ["--db-path", db_path]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"native search failed: {proc.stderr.strip()[:500]}")
    return proc.stdout.strip()
