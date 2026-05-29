#!/usr/bin/env python3
"""Live MCP smoke test: spawn the server over stdio and drive it as a client.

Proves the server speaks MCP end-to-end: initialize -> tools/list -> index ->
search -> describe. Uses the deterministic hash backend so it runs anywhere
(no torch, no GPU). Exits non-zero on any failure.

    python scripts/smoke_mcp.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def _seed(root: Path) -> None:
    reels = root / "content" / "skating" / "reels"
    notes = root / "content" / "skating" / "notes"
    reels.mkdir(parents=True)
    notes.mkdir(parents=True)
    (reels / "trick.png").write_bytes(b"\x89PNG\r\n" + b"frame" * 200)
    (notes / "ideas.md").write_text("backflip tailwhip handrail rooftop sunset session", encoding="utf-8")


async def main() -> int:
    workdir = Path(tempfile.mkdtemp(prefix="mneme-smoke-"))
    _seed(workdir)
    db = workdir / "smoke.db"

    env = dict(os.environ)
    env["MNEME_BACKEND"] = "hash"           # deterministic, no model download
    env["MNEME_DB_PATH"] = str(db)

    params = StdioServerParameters(command=sys.executable, args=["-m", "mneme", "serve"], env=env)

    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = {t.name for t in (await session.list_tools()).tools}
            print("tools:", sorted(tools))
            assert {"media_index", "media_search", "media_search_by_image", "media_describe"} <= tools

            idx = await session.call_tool("media_index", {"path": str(workdir)})
            idx_text = idx.content[0].text
            print("index:", idx_text)
            assert json.loads(idx_text)["indexed"] == 2

            res = await session.call_tool("media_search", {"query": "rooftop sunset session", "min_score": 0.0})
            hits = json.loads(res.content[0].text)
            print("search hits:", len(hits))
            assert hits, "expected at least one hit"

            top = hits[0]
            desc = await session.call_tool("media_describe", {"id": top["id"]})
            rec = json.loads(desc.content[0].text)
            print("describe:", rec)
            assert rec["metadata"].get("brand") == "skating"

    print("\nSMOKE OK ✓  (MCP handshake, index, search, describe all working)")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
