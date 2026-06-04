"""Mneme MCP server.

Exposes the polymathes media-memory tool surface over MCP stdio so any host
(OpenClaw, Hermes, Claude Desktop, Cursor, ...) can give its agent local visual
memory. Tool names, arguments, and result shape are intentionally identical to
the native C++ server in ``omni/mcp/mcp_server.hpp``.

Tools:
    media_index           index a directory of media files
    media_search          natural-language semantic search
    media_search_by_image reverse-image (find visually similar) search
    media_describe        fetch the full record for an asset id
    gpu_status            report local GPU / Ollama model state
    gpu_release           unload Ollama and lease the GPU to a user workflow
    gpu_reclaim           end a prior GPU lease
"""

from __future__ import annotations

import json
from typing import Optional

from mcp.server.fastmcp import FastMCP

from .artifacts import artifact_payload, media_artifact
from .config import Config
from .embedder import get_embedder
from .gpu import GpuBroker
from .indexer import Indexer
from .store import Store


class _Engine:
    """Lazily-constructed store + embedder so server startup stays instant."""

    def __init__(self, config: Config):
        self.config = config
        self._store: Optional[Store] = None
        self._embedder = None
        self.gpu = GpuBroker()

    @property
    def store(self) -> Store:
        if self._store is None:
            self.config.ensure_dirs()
            self._store = Store(self.config.db_path)
        return self._store

    @property
    def embedder(self):
        if self._embedder is None:
            self._embedder = get_embedder(self.config)
        return self._embedder


def _result_payload(results, *, query: str | None = None) -> str:
    return json.dumps(artifact_payload(results, query=query))


def build_server(config: Optional[Config] = None) -> FastMCP:
    config = config or Config.from_env()
    engine = _Engine(config)
    mcp = FastMCP("mneme")

    @mcp.tool()
    def media_index(path: str, frame_interval: float = 2.0, force: bool = False,
                    exclude: str = "") -> str:
        """Index a directory of media files (images, video, documents, code)."""
        stats = Indexer(engine.store, engine.embedder, config).scan_directory(
            path, force=force, exclude=exclude, frame_interval=frame_interval
        )
        return json.dumps({
            "path": path,
            "backend": engine.embedder.name,
            "total_indexed": engine.store.count(),
            **stats.as_dict(),
        })

    @mcp.tool()
    def media_search(query: str, top_k: int = 10, min_score: float = 0.25,
                     type_filter: str = "") -> str:
        """Natural-language semantic search over indexed media."""
        vec = engine.embedder.embed_text(query)
        results = engine.store.search(
            vec, top_k=top_k, min_score=min_score,
            type_filter=type_filter or None,
        )
        return _result_payload(results, query=query)

    @mcp.tool()
    def media_search_by_image(image_path: str, top_k: int = 10) -> str:
        """Reverse image search — find visually similar indexed media."""
        vec = engine.embedder.embed_image(image_path)
        results = engine.store.search(vec, top_k=top_k, min_score=config.min_score)
        return _result_payload(results, query=image_path)

    @mcp.tool()
    def media_describe(id: int) -> str:
        """Fetch the full record for an indexed asset by its id."""
        record = engine.store.get_by_id(id)
        if record is None:
            return json.dumps({"error": f"no asset with id {id}"})
        return json.dumps({"ok": True, "result": media_artifact(record)})

    @mcp.tool()
    def gpu_status() -> str:
        """Report local GPU / VRAM state and currently loaded Ollama models."""
        return json.dumps(engine.gpu.status())

    @mcp.tool()
    def gpu_release(reason: str = "agent handoff", hold_minutes: int = 60) -> str:
        """Unload Ollama models and reserve the GPU for another workflow."""
        return json.dumps(engine.gpu.release_gpu(reason=reason, hold_minutes=hold_minutes))

    @mcp.tool()
    def gpu_reclaim(token: str) -> str:
        """Release a prior GPU lease token returned by gpu_release."""
        return json.dumps(engine.gpu.reclaim(token))

    @mcp.tool()
    def gpu_evacuate() -> str:
        """Unload currently resident Ollama models without creating a lease."""
        return json.dumps(engine.gpu.evacuate())

    return mcp


def main() -> None:
    build_server().run()


if __name__ == "__main__":
    main()
