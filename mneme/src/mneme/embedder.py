"""Pluggable embedding backends.

The whole adoption strategy lives here: Mneme must *run* the moment it's
installed, and get *good* the moment the user opts into real models.

- OpenClipEmbedder : real CLIP (text<->image shared space). Needs [clip] extra.
- HashEmbedder     : deterministic, dependency-free fallback. NOT semantic —
                     it exists so the server boots, the MCP wiring is testable,
                     and identical inputs map to identical vectors.

A factory (`get_embedder`) selects one based on Config.backend, degrading
gracefully with a single stderr notice rather than crashing.
"""

from __future__ import annotations

import hashlib
import struct
import sys
from typing import Protocol

import numpy as np

from .config import Config


class Embedder(Protocol):
    name: str
    dim: int

    def embed_text(self, text: str) -> np.ndarray: ...
    def embed_image(self, path: str) -> np.ndarray: ...


def _l2(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=np.float32).ravel()
    n = float(np.linalg.norm(v))
    return v / n if n else v


class HashEmbedder:
    """Deterministic non-semantic embedder.

    Text is hashed into a bag-of-character-trigrams vector (so near-identical
    strings stay near each other); images/files are hashed from their bytes.
    Cross-modal (text query -> image) will NOT work — that's expected. This is
    a plumbing/test backend only.
    """

    name = "hash"

    def __init__(self, dim: int = 512):
        self.dim = dim

    def _bucket(self, token: str) -> int:
        h = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
        return struct.unpack("<Q", h)[0] % self.dim

    def embed_text(self, text: str) -> np.ndarray:
        vec = np.zeros(self.dim, dtype=np.float32)
        norm = (text or "").lower().strip()
        padded = f"  {norm}  "
        for i in range(len(padded) - 2):
            vec[self._bucket(padded[i:i + 3])] += 1.0
        return _l2(vec)

    def embed_image(self, path: str) -> np.ndarray:
        try:
            with open(path, "rb") as fh:
                data = fh.read(1 << 20)  # first 1 MiB is enough to be stable
        except OSError:
            data = path.encode("utf-8")
        vec = np.zeros(self.dim, dtype=np.float32)
        digest = hashlib.blake2b(data, digest_size=64).digest()
        for i, b in enumerate(digest):
            vec[(i * 7 + b) % self.dim] += float(b)
        return _l2(vec)


class OpenClipEmbedder:
    """Real CLIP embeddings via open_clip_torch (text & image, shared space)."""

    name = "openclip"

    def __init__(self, model: str, pretrained: str):
        import open_clip  # type: ignore
        import torch  # type: ignore

        self._torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self._model, _, self._preprocess = open_clip.create_model_and_transforms(
            model, pretrained=pretrained, device=self.device
        )
        self._model.eval()
        self._tokenizer = open_clip.get_tokenizer(model)
        with torch.no_grad():
            self.dim = int(self._model.encode_text(self._tokenizer(["probe"]).to(self.device)).shape[-1])

    def embed_text(self, text: str) -> np.ndarray:
        torch = self._torch
        with torch.no_grad():
            feats = self._model.encode_text(self._tokenizer([text]).to(self.device))
        return _l2(feats.cpu().numpy()[0])

    def embed_image(self, path: str) -> np.ndarray:
        torch = self._torch
        from PIL import Image  # type: ignore

        img = Image.open(path).convert("RGB")
        tensor = self._preprocess(img).unsqueeze(0).to(self.device)
        with torch.no_grad():
            feats = self._model.encode_image(tensor)
        return _l2(feats.cpu().numpy()[0])


def _openclip_available() -> bool:
    import importlib.util

    return all(importlib.util.find_spec(m) is not None for m in ("open_clip", "torch", "PIL"))


def get_embedder(config: Config) -> Embedder:
    """Resolve a concrete embedder from config, degrading gracefully."""
    backend = config.backend

    if backend in ("openclip", "auto"):
        if _openclip_available():
            return OpenClipEmbedder(config.clip_model, config.clip_pretrained)
        if backend == "openclip":
            raise RuntimeError(
                "backend=openclip but open_clip/torch/pillow are not installed. "
                "Install the extra:  pip install 'mneme-mcp[clip]'"
            )
        print(
            "[mneme] open_clip not found — using the non-semantic 'hash' fallback. "
            "Install 'mneme-mcp[clip]' for real visual search.",
            file=sys.stderr,
        )
        return HashEmbedder()

    if backend == "hash":
        return HashEmbedder()

    if backend == "native":
        # The native backend handles its own embedding inside the C++ binary;
        # callers route index/search through mneme.native instead of here.
        raise RuntimeError("backend=native is handled by mneme.native, not get_embedder")

    raise ValueError(f"unknown backend: {backend!r}")
