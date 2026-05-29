"""Directory walker that turns files into searchable, metadata-tagged vectors.

Mirrors the polymathes Indexer's file-type routing and guardrails. Images and
text/code are handled with zero heavy deps; video frame extraction is enabled
when OpenCV (the [video] extra) is importable, otherwise videos are recorded as
a single segment so they still surface in results.
"""

from __future__ import annotations

import importlib.util
import os
from dataclasses import dataclass, field
from pathlib import Path

from .config import Config
from .embedder import Embedder
from .pathmeta import build_metadata
from .store import Store

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".webm"}
AUDIO_EXTS = {".wav", ".mp3", ".flac", ".m4a", ".ogg"}
TEXT_EXTS = {".txt", ".md", ".rst"}
CODE_EXTS = {".cpp", ".h", ".hpp", ".py", ".js", ".ts", ".rs", ".go", ".java", ".dart"}


@dataclass
class IndexStats:
    scanned: int = 0
    indexed: int = 0
    skipped: int = 0
    errored: int = 0
    by_type: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "scanned": self.scanned,
            "indexed": self.indexed,
            "skipped": self.skipped,
            "errored": self.errored,
            "by_type": self.by_type,
        }


def _cv2_available() -> bool:
    return importlib.util.find_spec("cv2") is not None


def _image_size(path: str) -> tuple[int | None, int | None]:
    try:
        from PIL import Image  # type: ignore

        with Image.open(path) as im:
            return im.width, im.height
    except Exception:
        return None, None


class Indexer:
    def __init__(self, store: Store, embedder: Embedder, config: Config):
        self.store = store
        self.embedder = embedder
        self.config = config

    def scan_directory(self, root: str, *, force: bool = False, exclude: str = "",
                       frame_interval: float | None = None) -> IndexStats:
        stats = IndexStats()
        frame_interval = frame_interval or self.config.frame_interval
        root_path = Path(root).expanduser()

        for dirpath, _dirs, files in os.walk(root_path):
            if exclude and exclude in dirpath:
                continue
            for name in files:
                full = os.path.join(dirpath, name)
                stats.scanned += 1
                try:
                    self._process_file(full, stats, force=force, frame_interval=frame_interval)
                except Exception:  # noqa: BLE001 - keep indexing the rest
                    stats.errored += 1
        return stats

    def _process_file(self, path: str, stats: IndexStats, *, force: bool,
                      frame_interval: float) -> None:
        ext = Path(path).suffix.lower()

        if not force and self.store.has_path(path):
            stats.skipped += 1
            return

        size_mb = os.path.getsize(path) / (1024 * 1024) if os.path.exists(path) else 0
        if size_mb > self.config.max_file_mb:
            stats.skipped += 1
            return

        if ext in IMAGE_EXTS:
            self._index_image(path, stats, force=force)
        elif ext in VIDEO_EXTS:
            self._index_video(path, stats, force=force, frame_interval=frame_interval)
        elif ext in TEXT_EXTS or ext in CODE_EXTS:
            type_ = "code" if ext in CODE_EXTS else "document"
            self._index_text(path, type_, stats, force=force)
        else:
            stats.skipped += 1

    # -- per-type handlers ------------------------------------------------
    def _bump(self, stats: IndexStats, type_: str) -> None:
        stats.indexed += 1
        stats.by_type[type_] = stats.by_type.get(type_, 0) + 1

    def _index_image(self, path: str, stats: IndexStats, *, force: bool) -> None:
        if force:
            self.store.delete_path(path)
        w, h = _image_size(path)
        vec = self.embedder.embed_image(path)
        meta = build_metadata(path, w, h)
        self.store.save_asset(path, "image", vec, timestamp=0.0, metadata=meta)
        self._bump(stats, "image")

    def _index_video(self, path: str, stats: IndexStats, *, force: bool,
                     frame_interval: float) -> None:
        if force:
            self.store.delete_path(path)

        if not _cv2_available():
            # Fallback: one segment so the asset is still discoverable.
            vec = self.embedder.embed_image(path)
            meta = build_metadata(path, extra={"note": "frame extraction disabled (install [video])"})
            self.store.save_asset(path, "video_segment", vec, timestamp=0.0, metadata=meta)
            self._bump(stats, "video_segment")
            return

        import cv2  # type: ignore

        cap = cv2.VideoCapture(path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
        duration = total / fps if fps else 0
        if duration > self.config.max_video_seconds:
            cap.release()
            stats.skipped += 1
            return

        step = max(int(fps * frame_interval), 1)
        idx = 0
        from PIL import Image  # type: ignore
        import tempfile

        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % step == 0:
                ts = idx / fps if fps else 0.0
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                with tempfile.NamedTemporaryFile(suffix=".png", delete=True) as tmp:
                    Image.fromarray(rgb).save(tmp.name)
                    vec = self.embedder.embed_image(tmp.name)
                meta = build_metadata(path, frame.shape[1], frame.shape[0],
                                      extra={"frame_idx": idx})
                self.store.save_asset(path, "video_segment", vec, timestamp=ts, metadata=meta)
                self._bump(stats, "video_segment")
            idx += 1
        cap.release()

    def _index_text(self, path: str, type_: str, stats: IndexStats, *, force: bool) -> None:
        if force:
            self.store.delete_path(path)
        try:
            text = Path(path).read_text(encoding="utf-8", errors="ignore")
        except OSError:
            stats.errored += 1
            return
        if not text.strip():
            stats.skipped += 1
            return
        vec = self.embedder.embed_text(text[:8000])
        meta = build_metadata(path)
        self.store.save_asset(path, type_, vec, timestamp=0.0, metadata=meta)
        self._bump(stats, type_)
