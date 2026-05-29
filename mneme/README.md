<div align="center">

# Mneme · μνήμη

**Local visual memory for any AI agent.**

Give your agent eyes into your own photo & video library — semantic search by
natural language or by-image similarity, 100% local, no cloud, no API spend.

Speaks [MCP](https://modelcontextprotocol.io). Drops into **OpenClaw**, **Hermes**, **Claude Desktop**, **Cursor**, or anything else that speaks the protocol.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10+-blue.svg)](https://python.org)
[![MCP](https://img.shields.io/badge/MCP-server-purple.svg)](https://modelcontextprotocol.io)

</div>

---

## Why this exists

Every agent framework is racing to remember your *conversations*. None of them
can answer a content creator's actual question:

> *"Find me a clean rider shot for a blog header — from the bmx brand, photo
> only, shot vertical, 2024 or later."*

Your memory isn't your chat history. It's the 80 raw clips waiting to be edited,
the 200 finished reels, the 500 archive photos on a second drive. **Mneme makes
that library a first-class memory your agent can search** — and because it
speaks MCP, it plugs into the agent you already use instead of asking you to
switch.

Mneme is the portable front door to the [polymathes](https://github.com/bkennedyshit/polymathes)
`media-memory` engine: a pure-Python CLIP server you can install in one line,
that can *also* delegate to the fast CUDA + TensorRT C++ binary when you have it.

## Install

```bash
# Zero-config: run straight from the repo with uv
uvx --from 'mneme-mcp[clip]' mneme-mcp

# or install it
pip install 'mneme-mcp[clip]'      # real CLIP search (downloads a small model)
pip install mneme-mcp              # runs immediately on a non-semantic fallback
```

> Without the `[clip]` extra, Mneme still boots and every tool works — it just
> uses a deterministic, **non-semantic** fallback embedder so you can verify the
> wiring. Install `[clip]` for real visual search; add `[video]` to make
> reels/clips searchable frame-by-frame.

## Quick start

```bash
# Catalog a folder (uses the path as metadata — see "Creator-aware" below)
mneme index ~/MyContent

# Search it from the terminal
mneme search "rider mid-air against a sunset" --top-k 5

# Check status
mneme info
```

## Plug it into your agent

Mneme is launched by the host over stdio as `mneme-mcp`.

<details open>
<summary><b>Claude Desktop / Cursor</b> (<code>mcp.json</code> / config)</summary>

```json
{
  "mcpServers": {
    "mneme": {
      "command": "uvx",
      "args": ["--from", "mneme-mcp[clip]", "mneme-mcp"],
      "env": { "MNEME_DB_PATH": "~/.mneme/mneme.db" }
    }
  }
}
```
</details>

<details>
<summary><b>Hermes</b> (NousResearch/hermes-agent — native MCP client)</summary>

```bash
hermes mcp add mneme -- uvx --from 'mneme-mcp[clip]' mneme-mcp
# tools appear as media_index / media_search / media_search_by_image / media_describe
```
See `examples/hermes.md`.
</details>

<details>
<summary><b>OpenClaw</b> (mcporter / skill bridge)</summary>

```bash
mcporter add mneme -- uvx --from 'mneme-mcp[clip]' mneme-mcp
```
See `examples/openclaw.md`.
</details>

## Tools

Identical surface to the polymathes native server, so the two are interchangeable:

| Tool | What it does |
|---|---|
| `media_index(path, frame_interval, force, exclude)` | Walk a directory; embed images, video frames, docs, code |
| `media_search(query, top_k, min_score, type_filter)` | Natural-language semantic search |
| `media_search_by_image(image_path, top_k)` | Reverse-image / visual-similarity search |
| `media_describe(id)` | Full record for an asset id |

Asset types: `image`, `video_segment`, `audio_segment`, `document`, `code`.

## Creator-aware: the path *is* metadata

Mneme reads your folder layout the way the polymathes workspace convention
defines it, so results carry workflow meaning automatically:

```
<root>/content/<brand>/reels/clip.mp4   → brand=<brand>, intent=reel, warn_on_edit=true
<root>/input/<brand>/raw/clip.mp4       → brand=<brand>, workspace=input
<root>/archive/<brand>/photos/x.jpg     → brand=<brand>, intent=photo
```

That's why you can ask for *"the bmx brand, photo only, vertical"* and get it —
the agent filters on `metadata.brand` / `metadata.intent` from the search hits.

## Two tiers, one tool surface

| | Portable (default) | Native (optional) |
|---|---|---|
| Backend | open_clip (CPU/CUDA) | polymathes C++ + **TensorRT FP16** |
| Install | `pip install mneme-mcp[clip]` | build the engine, set `MNEME_NATIVE_BIN` |
| Best for | adoption, laptops, CI | large libraries, real-time, your GPU rig |

```bash
export MNEME_NATIVE_BIN=/path/to/omni-search   # Mneme delegates the heavy lifting
```

## Configuration (env)

| Var | Default | Notes |
|---|---|---|
| `MNEME_DB_PATH` | `~/.mneme/mneme.db` | catalog location |
| `MNEME_BACKEND` | `auto` | `auto` \| `openclip` \| `hash` \| `native` |
| `MNEME_CLIP_MODEL` | `ViT-B-32` | open_clip model |
| `MNEME_NATIVE_BIN` | – | path to the C++ engine |
| `MNEME_TOP_K` / `MNEME_MIN_SCORE` | `10` / `0.25` | search defaults |

## Also the backend for polymathes itself

polymathes' own agent ships the `media_*` tools as stubs that expect an external
media-memory MCP server (`core-node/src/tools/builtin/media.ts`). Mneme is a
drop-in for that role — so the same server powers both your polymathes agent and
any third-party MCP host.

## Status

v0.1 — extracted from polymathes as a standalone, MCP-native component. Portable
CLIP path + creator-aware metadata + native bridge are working. Audio
transcription and a hosted skills listing are next.

## License

MIT. Built by [Bill Kennedy](https://github.com/bkennedyshit). Part of the
[polymathes](https://github.com/bkennedyshit/polymathes) project.
