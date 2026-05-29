"""Runtime configuration for Mneme.

Values resolve in this order (last wins): built-in defaults -> environment
variables (``MNEME_*``) -> explicit overrides passed in code/CLI.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _default_home() -> Path:
    return Path(os.environ.get("MNEME_HOME", Path.home() / ".mneme"))


@dataclass
class Config:
    # Where the SQLite catalog + vectors live.
    db_path: Path = field(default_factory=lambda: _default_home() / "mneme.db")

    # Embedding backend: "auto" | "openclip" | "native" | "hash".
    #   auto    -> openclip if importable, else hash (with a one-line warning)
    #   openclip-> real CLIP via open_clip_torch (requires the [clip] extra)
    #   native  -> delegate to the polymathes C++ binary at MNEME_NATIVE_BIN
    #   hash    -> deterministic, non-semantic fallback (plumbing/tests only)
    backend: str = "auto"

    # open_clip model + pretrained tag. ViT-B-32 is small and fast; the default
    # mirrors the polymathes catalog so vectors are comparable.
    clip_model: str = "ViT-B-32"
    clip_pretrained: str = "laion2b_s34b_b79k"

    # Path to the optional native binary (omni-search / media-memory).
    native_bin: str | None = None

    # Search defaults — identical to the C++ engine.
    top_k: int = 10
    min_score: float = 0.25

    # Indexing defaults.
    frame_interval: float = 2.0
    max_video_seconds: float = 600.0
    max_file_mb: float = 2048.0
    classify_intent: bool = True

    @classmethod
    def from_env(cls) -> "Config":
        env = os.environ
        cfg = cls()
        if v := env.get("MNEME_DB_PATH"):
            cfg.db_path = Path(v).expanduser()
        if v := env.get("MNEME_BACKEND"):
            cfg.backend = v.strip().lower()
        if v := env.get("MNEME_CLIP_MODEL"):
            cfg.clip_model = v
        if v := env.get("MNEME_CLIP_PRETRAINED"):
            cfg.clip_pretrained = v
        if v := env.get("MNEME_NATIVE_BIN"):
            cfg.native_bin = v
        if v := env.get("MNEME_TOP_K"):
            cfg.top_k = int(v)
        if v := env.get("MNEME_MIN_SCORE"):
            cfg.min_score = float(v)
        if v := env.get("MNEME_FRAME_INTERVAL"):
            cfg.frame_interval = float(v)
        return cfg

    def ensure_dirs(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
