<div align="center">

# Πολυμαθής · Polymathes

**A local AI agent runtime that can actually see your work.**

OpenClaw-class agent framework + ChatRTX-class media retrieval, running on your own GPU.
No cloud. No subscription. MIT.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/Node-22+-brightgreen.svg)](https://nodejs.org)
[![Ollama friendly](https://img.shields.io/badge/Ollama-friendly-blue.svg)](https://ollama.com)
[![Windows + Linux](https://img.shields.io/badge/OS-Windows%20%7C%20Linux-lightgrey.svg)]()

<!-- demo gif goes here on launch -->

</div>

---

## What this is

**An agent runtime, like OpenClaw or Hermes Agent, but built for NVIDIA workstations and aware of your media.**

Polymathes is a long-running gateway daemon you talk to from a CLI, a web UI, Telegram, Discord, or anywhere else. It runs a ReAct loop against any LLM you point it at (Ollama, OpenAI, Anthropic, Google, llama.cpp, LM Studio, whatever speaks the protocol). It has 50+ built-in tools — shell, files, web search, browser automation, cron, voice, skills — and it plugs into [MCP](https://modelcontextprotocol.io) servers for anything else.

The one thing it has that the others don't: **a first-class C++ media memory that runs on your GPU.** Point it at your edited reels, photo library, or design archive, and the agent can actually *find* things in there. Locally. Fast. No API costs.

Think of it as:
- **OpenClaw** — the gateway, the messaging channels, the subagents, the skills
- **+ Hermes Agent** — the 50-tool self-registering runtime, the cron, the learning loop
- **+ ChatRTX** — the local-GPU media RAG, but callable by the agent as a tool instead of being the whole app

All in one process. Yours.

> ⚠️ This is early. v0.1.0. Architecture is solid (173 passing tests). Polish, documentation, and community plumbing are in progress. If you're here to break things and tell me how — welcome.

---

## Show me

### Agent doing agent stuff

```
> find the largest file in my Documents folder and tell me when it was modified

[tool] files.fs_glob({ pattern: "**/*", cwd: "~/Documents" })
[tool] files.fs_stat({ paths: [...] })

The largest file in ~/Documents is "archive_2024.zip" (3.2 GB),
last modified 2025-11-14 — that's almost 6 months ago.
```

### Media memory doing media memory

```
> find the reel where I shot the sunset gap at Green Rail

[tool] media.media_search({ query: "sunset gap at green rail" })

Found 3 matches from your indexed reels:
  [0.88] D:\AGENT\content\bmx\reels\2026-02\green-rail-gap.mp4 @ 00:12
  [0.71] D:\AGENT\content\bmx\reels\2026-01\golden-hour-lines.mp4 @ 01:05
  [0.58] D:\AGENT\content\bmx\reels\2025-11\rail-combo.mp4 @ 00:34
```

### Skill invocation

```
> weekly brief

[skill] skill.weekly-brief(input: "")
  → spawned subagent for this task
  → [tool] core.query_episodes({ date_from: "2026-05-02" })
  → [tool] media.media_search({ query: "nepa-ai reels" })
  → [tool] files.fs_write({ path: "~/Obsidian/weekly.md", ... })

Weekly brief saved to ~/Obsidian/weekly.md. 4 BMX reels this week,
2 nepa-ai reels, 3 sessions where I worked on polymath.
```

---

## Getting started

### What you need

- **Node 22+** (runtime)
- **Ollama** (recommended) or any OpenAI-compatible endpoint
- **Optional**: NVIDIA GPU + CUDA 11.8 + TensorRT for the media-memory capability (a separate build — see [capabilities/media-memory](capabilities/media-memory))

Ollama-first because it's free and runs on your GPU. Install Ollama, pull a tool-capable model:

```bash
ollama pull qwen2.5-coder:7b
# or: gpt-oss:20b, llama3:8b — anything with tool calling support
```

### Install

```bash
git clone https://github.com/bkennedy994/polymathes
cd polymathes/core-node
pnpm install
pnpm build
```

### First run

```bash
node dist/polymath.cjs
```

First run creates `~/.polymath/` with:
- `polymath.json` — config file (edit this to add Ollama or your LLM)
- `auth.key` — bearer token for the local HTTP API (keep private)
- `workspace/SOUL.md` — your AI's personality file, edit to taste
- `workspace/skills/` — where you install/create skills

Point the config at Ollama:

```json
{
  "llm": {
    "provider": "ollama",
    "model": "qwen2.5-coder:7b",
    "streaming": true
  }
}
```

Start chatting:

```bash
node dist/polymath.cjs
```

Or one-shot:

```bash
node dist/polymath.cjs "list the files in my Downloads folder"
```

---

## ⚠️ Working with your media (read this before indexing)

Polymathes can index your photos, videos, audio, and documents so the agent can semantically search them. This is powerful. It's also easy to footgun yourself on. Read this before you run the indexer.

### Index curated content, not raw footage

> **Don't index 60-minute 4K raw clips unless you're Google and have an array of H200s.**

Raw footage and edited work are different things:
- **Raw footage** is mostly redundant — same scene, same light, 100 variations of the same shot. Embeddings of raw footage retrieve badly because everything looks similar.
- **Edited work** (reels, shorts, cuts, finished pieces) is where the scene changes actually happen. Embeddings of edited work retrieve well.

Edit first, then index the reels and shorts. That's the workflow.

### Organize content by brand/project before indexing

The indexer walks a directory tree. If your content is scattered across random Downloads folders and Desktop dumps, the agent won't be able to help you.

A layout that works:

```
D:\AGENT\content\
  bmx\
    reels\           ← index this
    shorts\          ← index this
    longform\        ← maybe index, if edited
  nepa-ai\
    reels\           ← index this
    demos\           ← index this
  client-name\
    deliverables\    ← index this
```

Polymathes auto-tags assets with a `brand` from the path, so you can ask *"find nepa-ai reels about X"* and it filters correctly. The indexer also tags a `category` (`reels`, `shorts`, `photos`, `longform`, `archive`) based on folder names so the agent can filter even within a brand.

### Guardrails

The indexer has built-in size guardrails so you don't accidentally try to index a 2-hour 4K master:

- **Videos > 10 minutes** are skipped with a warning suggesting you edit them down first
- **Files > 2 GB** are skipped with the same suggestion
- Pass `--force-large` to override, or adjust with `--max-video-minutes <N>` and `--max-file-mb <N>`

These exist because the retrieval quality on raw footage is bad. Your 60-minute raw cam roll of one park session looks the same at every frame; your edited 45-second reel has distinct scenes. The agent finds what you want in the reel, not the roll.

### Content intelligence

Beyond semantic embeddings, the indexer understands **what kind of content each file is**:

- **Path-based**: your folder layout (`content/<brand>/reels/...`) gets tagged `brand=<brand>` and `category=reels`
- **Aspect-ratio heuristics**: 1:1 is tagged `intent=post`, 2:3 portrait = `intent=pin`, 9:16 = `intent=reel`, 16:9 = `intent=thumbnail`. Free, fast, zero model cost.
- **Optional vision-model tags**: pass `--vlm-tag` and the indexer will call a local VLM (default: `qwen2.5vl:7b` via Ollama) per image to generate 3-5 content tags. Slow but gives the agent real semantic handles.

This means queries like *"find my Pinterest pins about BMX"* or *"find the thumbnail I made for last week's video"* actually filter before semantic search. The difference between "here are 50 red-and-sunset images" and "here are 3 Pinterest pins with BMX".

### Where Polymath thinks things live

Polymath keeps its own state in `~/.polymath/` — that's your config, auth token, SOUL.md, skills, episodes, audit log. That's the **brain**, and it lives with your apps (typically on C:).

Your **content** is somewhere else — `D:\Content\`, `F:\Archives\`, wherever. Polymath doesn't move it, doesn't copy it, doesn't modify it. You point the indexer at it; the indexer reads, embeds, and writes the index into Polymath's own database. Your files stay where they are.

You can index from multiple drives/paths. Each `omni_search index <path>` run adds to the same database.

### Photos — same idea

Indexing a curated archive of photos works great:

```
F:\Archives\Picture Archive\RIDING PICTURES UPSCALED\
D:\AGENT\content\bmx\photos\
```

Indexing your entire 2TB "Pictures" folder with 12 years of phone backups, screenshots of memes, and random downloads — works, but results will be noisy. The retrieval is only as good as what's in the index.

### Cost

Image embedding on RTX 3090 with TensorRT: ~2ms per image.
A curated folder of 5,000 reels + photos: about 10 seconds to index.
A folder of 500,000 unorganized files: don't.

### Indexing

```bash
# Build and run media-memory standalone
./capabilities/media-memory/build/Release/omni_search.exe index "D:\AGENT\content\bmx\reels"

# Or via the agent
> index my bmx reels folder
```

See [capabilities/media-memory/README.md](capabilities/media-memory/README.md) for the build process.

---

## How it works

```
                           Users (everywhere)
                                    │
    ┌───────┬───────┬───────┬───────┴──────┬───────┬───────┐
    │       │       │       │              │       │       │
  CLI     Web    Telegram Discord        Signal   Email   ...
    └───────┴───────┴───────┴───────┬──────┴───────┴───────┘
                                    │
    ┌───────────────────────────────▼─────────────────────────┐
    │  POLYMATHES GATEWAY (single Node daemon)               │
    │                                                         │
    │  Orchestrator ─┬─ Tool Registry (50+ tools, Hermes-style│
    │                │                   self-registering)    │
    │                ├─ Skills (SKILL.md files, subagent-run) │
    │                ├─ MCP Client (media-memory, others)     │
    │                ├─ Memory (working/episodic/semantic/    │
    │                │           procedural — FTS5 + embed)   │
    │                ├─ Sandbox (host/docker/wsl/firejail/ssh)│
    │                ├─ Pairing + Approval queue              │
    │                ├─ Cron scheduler                        │
    │                └─ Audit log (SQLite, append-only)       │
    │                                                         │
    │  LLM Adapter ──> Ollama | OpenAI | Anthropic | Google   │
    │                  + any OpenAI-compat endpoint           │
    └─────────────────────────────────────────────────────────┘
                             │ (MCP stdio)
                    ┌────────┴────────┐
                    │                 │
           media-memory           your-MCP-server
           (C++ / CUDA /          (whatever you
            TensorRT)              plug in)
```

**Everything is one process except MCP capabilities**, which run as subprocesses and speak JSON-RPC over stdin/stdout. Standard Model Context Protocol — your own MCP servers plug in with zero Polymathes-specific code.

---

## What ships in v0.1.0

### Built-in toolsets (50+ tools)

| Toolset | Tools |
|---|---|
| `terminal` | `shell_run`, `shell_run_streaming`, `shell_run_script` |
| `files` | `fs_read`, `fs_write`, `fs_edit` (unified diff), `fs_glob`, `fs_ls`, `fs_stat`, `fs_delete`, `fs_mkdir`, `fs_move` |
| `processes` | `proc_list`, `proc_kill`, `proc_spawn`, `proc_wait` |
| `web` | `web_search` (Serper / Tavily / Brave / DuckDuckGo), `web_fetch`, `web_fetch_full`, `web_extract`, `web_screenshot` |
| `browser` | Persistent Playwright session: `browser_open`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_eval`, `browser_scrape_dom`, `browser_close` |
| `media` | Proxies to `media-memory` MCP: `media_index`, `media_search`, `media_search_by_image`, `media_describe` |
| `comms` | `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn` (subagents), `channel_send` |
| `cron` | `cron_add`, `cron_list`, `cron_remove`, `cron_trigger_now`, `cron_enable`, `cron_disable` |
| `memory` | `memory_recall`, `memory_recall_session`, `memory_recall_by_date`, `memory_pin`, `memory_forget`, `memory_list_sessions` |
| `vision` | `image_describe`, `image_ocr`, `image_generate` |
| `voice` | `tts`, `stt` |
| `code_exec` | `execute_code` (Python / TypeScript / Bash / PowerShell) — always sandboxed |
| `input` | Virtual HID mouse/keyboard — gated, opt-in |
| `skills` | Discovered SKILL.md files register here as `skill.<name>` |

### Transports

- **CLI** — REPL + one-shot (`polymath "do X"`)
- **WebChat** — local web UI at `http://127.0.0.1:18789`
- **Telegram** — bot token, voice notes auto-transcribed (Whisper), pairing flow for unknown senders
- **Discord** — bot token, DMs + guild channels
- **Signal** — via signal-cli (docs in `docs/CHANNELS.md`)
- **Email** — IMAP + SMTP

### Control UI

A local web dashboard at `http://127.0.0.1:18789`:
- Dashboard · Chat · Tools · Sessions · Skills · Cron · Memory · Channels · MCP · Audit · Doctor · Config

### Security

- **Pairing** — unknown Telegram/Discord/Signal senders get a pairing code; you approve via CLI
- **Approval queue** — dangerous tools (shell_run, fs_delete, etc.) ask before running; default-deny on timeout
- **Sandbox backends** — host (default for main session), docker, wsl, firejail, ssh
- **Path allowlists** — `fs_write` restricted to explicit paths via policy
- **Append-only audit** — every tool call logged; SQLite trigger prevents edit/delete
- **Bearer token** — local HTTP API auth, generated on first run

---

## LLM support

Anything that speaks the OpenAI, Anthropic, or Gemini protocols. Tested with:

- **Ollama** (recommended — free, local, works on GPU)
- **OpenAI** (gpt-5, gpt-5-mini, gpt-5-nano)
- **Anthropic** (claude-4.5-sonnet, opus-4.1)
- **Google** (gemini-3-pro, gemini-2.5-flash)
- **OpenRouter** (any model they route)
- **Groq** (fast inference)
- **LM Studio** (local)
- **llama.cpp server** (local)
- **Together AI**

Per-agent model overrides supported. Failover lists supported.

---

## Writing skills

A skill is a markdown file at `~/.polymath/workspace/skills/<name>/SKILL.md`:

```yaml
---
name: weekly-brief
description: Summarize this week's work across BMX, nepa-ai, and agent dev
toolsets: [files, media, memory]
---

# Weekly Brief

1. Query memory for episodes from the past 7 days.
2. Search media for reels created this week.
3. Write a summary to `~/Obsidian/briefs/YYYY-MM-DD.md`.
```

On Gateway boot, skills are discovered and registered as tools named `skill.<name>`. When the LLM calls one, Polymathes spawns a subagent with that SKILL.md as the system prompt.

Skills are portable — compatible with [agentskills.io](https://agentskills.io) format, shareable across agent runtimes.

---

## Roadmap

### v0.1.0 (now)
- [x] Gateway + all major subsystems
- [x] 50+ built-in tools
- [x] Skills system with subagent invocation
- [x] 6 transports (CLI, WebChat, Telegram, Discord, Signal, Email)
- [x] Control UI
- [x] Media-memory C++ capability with size guardrails, intent classification, optional VLM tagging
- [x] Virtual-input MCP wrapper (Linux uinput)
- [x] 174 passing tests

### v1.1
- [ ] Watch-mode indexing (auto re-index on file change)
- [ ] Signed one-line installers
- [ ] Virtual-input Windows port (Interception driver backend)
- [ ] Web search + social content skills (general patterns for creators)
- [ ] Voice wake word on by default
- [ ] HNSW vector index for archives > 100k assets

### Later
- [ ] Rust port of the Gateway (smaller binary, faster startup)
- [ ] Skills marketplace UI
- [ ] Multi-user Gateway (for teams)
- [ ] Mobile companion apps

---

## Credits and inspiration

- [**OpenClaw**](https://github.com/openclaw/openclaw) — the gateway + multi-channel + skills pattern
- [**Hermes Agent**](https://hermes-agent.nousresearch.com/) — the 68-tool self-registering runtime, the learning loop
- [**ChatRTX**](https://github.com/NVIDIA/ChatRTX) — the local GPU RAG pattern (shelved by NVIDIA 1/21/2026; Polymathes keeps that idea alive as a capability, not an app)
- [**OpenCLIP**](https://github.com/mlfoundations/open_clip) — the embedding model family powering media-memory
- [**Model Context Protocol**](https://modelcontextprotocol.io) — the integration standard

---

## License

MIT. See [LICENSE](LICENSE). The whole point is adoption — use it, fork it, ship your own thing on top of it.

---

## About

Built by [Bill Kennedy](https://github.com/bkennedy994) / [nepa-ai.com](https://nepa-ai.com) — BMX rider, creator, and systems engineer building tools for the overlap of content, code, and automation.

If you build something cool with this, open an issue or DM. I want to see it.
