"""Path-as-metadata inference.

This is the part that makes Mneme *creator-aware* rather than a generic image
search: the file's location in your workspace tells us what it is. Ported from
the polymathes ``Indexer::infer_brand`` / ``build_metadata`` / ``classify_intent``
heuristics so behaviour matches the native engine.

Convention (RetroArch-style — the convention is the contract):

    <root>/content/<brand>/reels/clip.mp4   -> brand=<brand>, category=reel
    <root>/input/<brand>/raw/clip.mp4       -> brand=<brand>, category=raw
    <root>/archive/<brand>/photos/x.jpg     -> brand=<brand>, category=photo
"""

from __future__ import annotations

import re
from pathlib import PurePosixPath
from typing import Optional

# Top-level workspace buckets that carry workflow meaning.
_WORKSPACE_ROOTS = {"content", "input", "output", "archive"}

# Folder-name hints -> intent. Cheap, deterministic.
_FOLDER_INTENT = {
    "reels": "reel",
    "reel": "reel",
    "shorts": "short",
    "short": "short",
    "stories": "story",
    "story": "story",
    "posts": "post",
    "post": "post",
    "pins": "pin",
    "pin": "pin",
    "thumbnails": "thumbnail",
    "thumbs": "thumbnail",
    "photos": "photo",
    "photo": "photo",
}


def _parts(path: str) -> list[str]:
    # Normalise Windows separators so the same logic works cross-platform.
    return [p for p in PurePosixPath(path.replace("\\", "/")).parts if p not in ("/", "")]


def infer_brand(path: str) -> Optional[str]:
    """Return the brand segment following a known workspace root, else None.

    ``.../content/skating/reels/x.mp4`` -> ``"skating"``.
    """
    parts = _parts(path)
    for i, seg in enumerate(parts[:-1]):
        if seg.lower() in _WORKSPACE_ROOTS and i + 1 < len(parts) - 0:
            candidate = parts[i + 1]
            # Guard against the brand slot actually being the file itself.
            if i + 1 < len(parts) - 1 or not _looks_like_file(candidate):
                return candidate
    return None


def infer_workspace_root(path: str) -> Optional[str]:
    """Return which workflow bucket the asset lives under (content/input/...)."""
    for seg in _parts(path):
        low = seg.lower()
        if low in _WORKSPACE_ROOTS:
            return low
    return None


def classify_intent(path: str, width: int | None = None, height: int | None = None) -> str:
    """Best-guess content intent from folder hints + aspect ratio.

    Folder hints win when present; otherwise aspect ratio decides:
    tall (<0.9) -> story/reel surface, square (~1.0) -> post, wide -> thumbnail.
    """
    for seg in reversed(_parts(path)):
        hint = _FOLDER_INTENT.get(seg.lower())
        if hint:
            return hint

    if width and height and height > 0:
        ar = width / height
        if ar < 0.9:
            return "reel"  # vertical
        if ar < 1.2:
            return "post"  # roughly square
        return "thumbnail"  # landscape
    return "other"


def _looks_like_file(name: str) -> bool:
    return bool(re.search(r"\.[A-Za-z0-9]{1,5}$", name))


def build_metadata(path: str, width: int | None = None, height: int | None = None,
                   extra: dict | None = None) -> dict:
    """Assemble the base metadata dict attached to every indexed asset."""
    meta: dict = {}
    brand = infer_brand(path)
    if brand:
        meta["brand"] = brand
    root = infer_workspace_root(path)
    if root:
        meta["workspace"] = root

    intent = classify_intent(path, width, height)
    meta["intent"] = intent
    meta["is_reel"] = intent in ("reel", "short", "story")
    meta["is_photo"] = intent in ("photo", "post", "pin", "thumbnail")

    # Finished, brand-owned content is protected: warn agents off re-editing it.
    meta["warn_on_edit"] = root == "content"

    if width and height:
        meta["width"] = width
        meta["height"] = height

    if extra:
        meta.update(extra)
    return meta
