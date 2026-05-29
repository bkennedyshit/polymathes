<div align="center">

# Mneme · μνήμη

**Local visual memory for any AI agent.**

Lets your AI assistant search your own photos & videos in plain English
("rider mid-air at sunset") or by example image. Runs 100% on your machine.
Plugs into OpenClaw, Hermes, Claude Desktop, Cursor — and your own polymathes agent.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10+-blue.svg)](https://python.org)
[![MCP](https://img.shields.io/badge/MCP-server-purple.svg)](https://modelcontextprotocol.io)

</div>

> **New to this and not sure what's going on?** Read [`START_HERE.md`](START_HERE.md)
> first — it explains every term in plain English. This file is just: *how to run it.*

---

## ⚡ Run it on your machine in 5 minutes

You need **one** thing installed first: `uv` (a fast Python tool that also installs
Python for you so you don't have to). Get it:

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows (PowerShell)
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Then:

```bash
# 1. Get the code
git clone https://github.com/bkennedyshit/polymathes.git
cd polymathes/mneme

# 2. Create an isolated environment and install Mneme into it
uv venv
#    activate it:
source .venv/bin/activate          # macOS / Linux
#    .venv\Scripts\Activate.ps1     # Windows PowerShell  (use this line instead on Windows)

uv pip install -e .                # quick install (see note below about real search)
```

That's it. Now prove it works (this needs no GPU and no big downloads):

```bash
# Does the whole thing actually run as an MCP server? This drives it end-to-end:
python scripts/smoke_mcp.py
# -> should print:  SMOKE OK ✓  (MCP handshake, index, search, describe all working)

# Try the catalog yourself on a folder of files:
mneme index ~/Pictures            # or any folder:  mneme index "C:\Users\you\Pictures"
mneme info                        # shows how many files it catalogued
mneme search "sunset" --min-score 0.0
```

> **Two install levels:**
> - `uv pip install -e .` → runs instantly, but uses a **non-semantic fallback**
>   (good for "does it run?", not for real search results).
> - `uv pip install -e ".[clip]"` → **real** visual search. First run downloads
>   PyTorch + a small CLIP model (a couple GB, one time). Use this when you want
>   it to actually understand your images.
> - add `,video` (i.e. `".[clip,video]"`) to also search inside videos frame-by-frame.

### Run the 60-second demo (macOS / Linux)

```bash
bash scripts/demo.sh
```

It seeds a fake creator folder, indexes it, and runs a search — so you can see
the whole flow without touching your real files. (On Windows, run the three
`mneme` commands above instead, or use Git Bash / WSL.)

---

## 🔌 Plug it into your AI assistant

Your assistant launches Mneme for you over a standard connection (MCP). You just
add a few lines to that assistant's config.

<details open>
<summary><b>Claude Desktop</b> — edit its config file</summary>

macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
Windows: `%APPDATA%\Claude\claude_desktop_config.json`

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
(See [`examples/claude_desktop.json`](examples/claude_desktop.json).)

> Note: `uvx --from mneme-mcp[clip] ...` only works once Mneme is **published to
> PyPI**. Until then, point `command` at your local install — ask and I'll wire
> the exact local path for you.
</details>

<details>
<summary><b>Cursor</b></summary>

`~/.cursor/mcp.json` — same block as above. See [`examples/cursor_mcp.json`](examples/cursor_mcp.json).
</details>

<details>
<summary><b>Hermes</b> (NousResearch)</summary>

```bash
hermes mcp add mneme -- uvx --from 'mneme-mcp[clip]' mneme-mcp
```
Full walkthrough: [`examples/hermes.md`](examples/hermes.md).
</details>

<details>
<summary><b>OpenClaw</b></summary>

```bash
mcporter add mneme -- uvx --from 'mneme-mcp[clip]' mneme-mcp
```
Full walkthrough: [`examples/openclaw.md`](examples/openclaw.md).
</details>

Once added, your assistant gains four tools:

| Tool | What it does |
|---|---|
| `media_index` | catalogue a folder of photos/videos/docs |
| `media_search` | find things by describing them |
| `media_search_by_image` | find things that look like an example image |
| `media_describe` | get full details for one result |

---

## 🎯 It understands your folders

Mneme reads your folder layout the way the polymathes workspace does, so results
come back tagged automatically:

```
<root>/content/<brand>/reels/clip.mp4   → brand=<brand>, intent=reel, warn_on_edit=true
<root>/input/<brand>/raw/clip.mp4       → brand=<brand>, workspace=input
<root>/archive/<brand>/photos/x.jpg     → brand=<brand>, intent=photo
```

That's why you can ask for *"the bmx brand, photo only, vertical"* and get it —
the tags ride along with every search result.

---

## 🧩 It's also the backend for polymathes itself

Your polymathes agent ships the `media_*` tools as **stubs** that expect an
external media-memory server (`core-node/src/tools/builtin/media.ts` returns
*"media-memory MCP server not connected"*). Mneme fills that role — so one
program powers both your own agent and any third-party assistant.

---

## ⚙️ Settings (all optional, set as environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `MNEME_DB_PATH` | `~/.mneme/mneme.db` | where the catalogue is stored |
| `MNEME_BACKEND` | `auto` | `auto` \| `openclip` (real) \| `hash` (fallback) \| `native` |
| `MNEME_CLIP_MODEL` | `ViT-B-32` | which CLIP model to use |
| `MNEME_NATIVE_BIN` | – | path to your C++/TensorRT engine for max speed |
| `MNEME_TOP_K` / `MNEME_MIN_SCORE` | `10` / `0.25` | search result defaults |

---

## 📚 The other docs (when you're ready)

- [`START_HERE.md`](START_HERE.md) — plain-English orientation + every term defined.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — the **AI video-editing** plan (your north star).
- [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) — exact script for your demo video.
- [`docs/UPSTREAM_PITCH.md`](docs/UPSTREAM_PITCH.md) — where to submit it + the get-hired plan.

---

## Status

v0.1 — early but working: real CLIP search, creator-aware tags, native bridge,
17 passing tests + a live MCP smoke test. Audio transcription and a PyPI release
are next. Video **editing** (vs. search) is the next wedge — see the roadmap.

## License

MIT. Built by [Bill Kennedy](https://github.com/bkennedyshit). Part of
[polymathes](https://github.com/bkennedyshit/polymathes).
