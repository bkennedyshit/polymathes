"""Media artifact result shape shared by MCP hosts.

Mneme does not style host UI. It returns neutral structured data so OpenClaw,
Hermes, Claude Desktop, or Polymath can render using their own components.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

from .store import SearchResult


def kind_from_type(type_: str) -> str:
    if type_ == "video_segment":
        return "video"
    if type_ == "audio_segment":
        return "audio"
    if type_ in {"image", "document", "code"}:
        return type_
    return "unknown"


def media_artifact(result: SearchResult) -> dict:
    kind = kind_from_type(result.type)
    title = Path(result.path).name
    artifact = {
        "id": result.id,
        "title": title,
        "kind": kind,
        "type": result.type,
        "path": result.path,
        "score": round(result.score, 4),
        "preview": kind in {"image", "video", "audio"},
        "actions": ["preview", "reveal", "copy_path"],
        "reason": _reason(result),
    }
    if result.timestamp:
        artifact["timestamp"] = result.timestamp
        artifact["time_range"] = {
            "start": max(result.timestamp - 1.0, 0.0),
            "end": result.timestamp + 1.0,
        }
    if result.metadata:
        artifact["metadata"] = result.metadata
    return artifact


def artifact_payload(results: Iterable[SearchResult], *, query: str | None = None) -> dict:
    items = [media_artifact(r) for r in results]
    return {
        "ok": True,
        "query": query,
        "results": items,
        "returned": len(items),
        "output_contract": "media_artifacts.v1",
    }


def _reason(result: SearchResult) -> str:
    bits: list[str] = []
    brand = result.metadata.get("brand") if result.metadata else None
    intent = result.metadata.get("intent") if result.metadata else None
    if brand:
        bits.append(f"brand={brand}")
    if intent:
        bits.append(f"intent={intent}")
    if result.timestamp:
        bits.append(f"match near {result.timestamp:.1f}s")
    bits.append(f"score={result.score:.3f}")
    return ", ".join(bits)
