"""Small local GPU broker for MCP hosts.

This mirrors the useful part of Polymath's GPU broker without depending on
Polymath. It lets an agent briefly unload Ollama models before a GPU-heavy user
workflow, then release that lease later.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field


@dataclass
class GpuLease:
    token: str
    owner: str
    reason: str
    expires_at: float


@dataclass
class GpuBroker:
    ollama_url: str = field(default_factory=lambda: os.environ.get("MNEME_OLLAMA_URL", "http://127.0.0.1:11434"))
    lease: GpuLease | None = None

    def status(self) -> dict:
        snap = gpu_snapshot(self.ollama_url)
        self._expire_if_needed()
        return {
            "ok": True,
            "status": "claimed" if self.lease else "idle",
            "lease": self.lease.__dict__ if self.lease else None,
            **snap,
        }

    def release_gpu(self, reason: str = "agent handoff", hold_minutes: int = 60) -> dict:
        self.evacuate()
        token = uuid.uuid4().hex
        self.lease = GpuLease(
            token=token,
            owner="agent-released",
            reason=reason,
            expires_at=time.time() + max(hold_minutes, 1) * 60,
        )
        return {"ok": True, "token": token, "status": self.status()}

    def reclaim(self, token: str) -> dict:
        if not self.lease:
            return {"ok": True, "status": self.status()}
        if token != self.lease.token and token != "force":
            return {"ok": False, "error": "invalid or stale GPU lease token", "status": self.status()}
        self.lease = None
        return {"ok": True, "status": self.status()}

    def evacuate(self) -> dict:
        models = ollama_models(self.ollama_url)
        for name in models:
            ollama_unload(self.ollama_url, name)
        return {"ok": True, "evacuated_models": models}

    def _expire_if_needed(self) -> None:
        if self.lease and self.lease.expires_at <= time.time():
            self.lease = None


def gpu_snapshot(ollama_url: str) -> dict:
    used = 0
    total = 0
    try:
        proc = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            first = proc.stdout.strip().splitlines()[0]
            parts = [int(p.strip()) for p in first.split(",")[:2]]
            used, total = parts[0], parts[1]
    except Exception:
        pass

    models = ollama_models(ollama_url)
    return {
        "vram_used_mb": used,
        "vram_total_mb": total,
        "loaded_models": models,
        "ollama_url": ollama_url,
    }


def ollama_models(ollama_url: str) -> list[str]:
    try:
        with urllib.request.urlopen(ollama_url.rstrip("/") + "/api/ps", timeout=2) as res:
            data = json.loads(res.read().decode("utf-8"))
        return [m.get("name") for m in data.get("models", []) if m.get("name")]
    except Exception:
        return []


def ollama_unload(ollama_url: str, model: str) -> None:
    payload = json.dumps({"model": model, "prompt": "", "keep_alive": 0}).encode("utf-8")
    req = urllib.request.Request(
        ollama_url.rstrip("/") + "/api/generate",
        data=payload,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=5).read()
    except (urllib.error.URLError, TimeoutError):
        pass
