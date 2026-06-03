<div align="center">

# Πολυμαθής · Polymathes

**A local AI agent for content creators.**

Knows your video and photo workflow. Swaps models so you don't have to. Runs on your own GPU.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/Node-22+-brightgreen.svg)](https://nodejs.org)
[![Ollama friendly](https://img.shields.io/badge/Ollama-friendly-blue.svg)](https://ollama.com)
[![CUDA + TensorRT](https://img.shields.io/badge/CUDA%2BTensorRT-media%20memory-76B900.svg)]()
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ff69b4.svg)](https://github.com/sponsors/bkennedyshit)

</div>

---

## What this actually is

Most "agent frameworks" optimize for chat memory — Hermes, Mem0, Honcho, Letta, etc. They're all converging on the same primitives: episodic transcripts, semantic facts, summarization loops. Pick whichever has the prettiest CLI.

**Polymath optimizes for media.**

If you create content for a living — videos, photos, reels, blog imagery — your "memory" isn't your conversation history. It's:

- The 80 raw sessions in `D:\AGENT\input\<your-brand>\` waiting to be edited
- The 200 finished reels in `content/<your-brand>/reels/` and which ones you've posted to which platform
- The 500 archive photos on a separate drive that the agent can find by visual similarity
- The convention you use to organize all of it, which the agent reads as metadata

Polymath is the only local agent that treats this as first-class memory. Everything else here — the GPU broker, the skill system, the workspace template, the 4-tier text memory — exists to support that core capability.

---

## The four things nobody else does

### 1. Workspace convention as a feature

Run `polymath init D:\MyContent --brands=skating,music`. You get a tree:

```
input/         # drop content here for the agent
content/       # your finished, brand-owned output
output/        # agent-generated work product
archive/       # read-only references
skills/        # your local skill files (gitignored, never published)
```

Every directory has a README explaining what goes there. The agent reads paths as metadata: `input/<brand>/raw/clip.mp4` → category=raw, brand=<brand>, intent=agent-input. `content/<brand>/reels/clip.mp4` → category=reel, workflow_state=ready-to-post, **warn-on-edit so the agent won't re-cut your finished work**.

It's RetroArch for content. The convention is the contract.

### 2. CUDA + TensorRT media memory

A C++ binary, not a Python wrapper. CLIP embeddings on your videos and photos, indexed in milliseconds, queryable by natural language or by-image similarity. Joins back to the structured catalog so you can ask:

> *"Find me a clean product shot for a blog header — must be from the brand-a catalog, photo only, upscaled, taken in 2024 or later."*

The agent runs `media.vision_search`, gets vector hits, joins with metadata, returns the top 5. No cloud round-trip. No API spend. Your archive stays on your drive.

### 3. Cooperative GPU arbitration

You and the agent share one GPU. When you open DaVinci Resolve to render, Polymath notices VRAM pressure and steps off. When you finish, she comes back. You never manage `keep_alive` flags or restart anything.

Same broker handles model swaps for skills: `session-highlight-editor` declares `model: qwen2.5vl:7b` in its frontmatter, so when you ask the agent to analyze a video session, she evacuates her main brain (gpt-oss:20b), loads the vision model, runs the skill, and lazy-reloads her brain on the next message. Zero manual VRAM management.

### 4. Skills are products

The framework is open. Your skills are private — gitignored by default, stored at `~/.polymath/skills/`. A skill is a markdown file with frontmatter:

```yaml
---
name: session-highlight-editor
description: Analyze a raw creator session into highlights
model: qwen2.5vl:7b
toolsets: [files, media]
---

You are a specialist editor that…
```

The framework discovers it, registers it as `skill.session-highlight-editor`, and the agent calls it like any other tool. Sell skills, package skills, keep skills private — your call.

---

## What's in the box (v0.1)

- **Local agent runtime**: ReAct loop, 70+ built-in tools (shell, files, web, browser automation, cron, voice STT, memory, media, GPU broker, channel comms)
- **Multi-LLM**: Ollama, LM Studio, OpenAI, Anthropic, Google, OpenRouter, Groq, Together, Azure, Mistral, DeepSeek, Cohere, custom OpenAI-compat — all hot-swappable from the UI
- **MCP support**: client (consumes any MCP server) AND server (Polymath itself exposes its tools to other agents)
- **4-tier memory**: working (in-RAM), episodic (SQLite + FTS5), semantic (vectors + cosine), procedural (per-workspace SOUL.md)
- **Background consolidation**: idle sessions get summarized into atomic facts; long sessions get oldest half compressed automatically
- **Media catalog**: structured `media_items` + `media_workflow` tables with FTS triggers, brand/category auto-inference from path
- **Vision search**: C++ binary with CUDA 11.8 + TensorRT 10.16, exposed as MCP tool
- **GPU broker**: explicit claims, ghost-claims for external pressure, per-skill model swap, busy-reply rate limit
- **Channels**: Telegram, Discord, Signal (via signal-cli), Email (IMAP+SMTP), Web chat, CLI
- **Web UI**: 13 tabs (Chat with streaming tool-call traces, Dashboard, Tools, Sessions, Skills, Memory, Media, Cron, Channels, MCP, GPU, Audit, Doctor, Settings)
- **Pairing + approval queue**: external senders need explicit owner approval before reaching the agent
- **Streaming context scrubber**: prompt-injection defense on recalled memory
- **Doctor**: real diagnostic with latency-tracked checks for gateway, DB, LLM, embedder, MCP servers, disk

---

## Quick start (Windows + NVIDIA GPU)

```powershell
# Install
git clone https://github.com/bkennedyshit/polymathes.git
cd polymathes\core-node
pnpm install
pnpm build

# Set up your workspace (RetroArch-style — pick your own brands)
node dist\polymath.cjs init D:\MyContent --brands=brand-a,brand-b

# Catalog existing files
node dist\polymath.cjs media seed D:\MyContent

# Boot the gateway
node dist\polymath.cjs

# Open http://localhost:18789, paste the token from ~/.polymath/auth.key
```

For the C++ media-memory binary you'll need CUDA 11.8 + TensorRT 10.16 + CMake. Build instructions in `capabilities/media-memory/README.md`.

---

## Quick start with your ChatGPT subscription (no API key required)

If you already pay for ChatGPT Plus / Pro / Business, you can use the same auth your Codex CLI uses. Polymath orchestrates the conversation through GPT-5.5, while your local Ollama fleet keeps doing embeddings, vision, and skill specialists. **Free if you already have the sub. No new credit card.**

```powershell
# If you have Codex CLI installed already, copy its tokens over:
node dist\polymath.cjs llm import-codex

# Otherwise sign in through your browser (PKCE flow, just like Codex CLI):
node dist\polymath.cjs llm login

# Flip your provider in ~/.polymath/polymath.json:
#   "llm": { "provider": "openai-codex", "model": "gpt-5.5" }
# Optional: keep your local Ollama for embeddings and vision skills:
#   "memory": { "embedder_base_url": "http://localhost:11434/v1" }

# Boot — GPT-5.5 orchestrates, your RTX still serves embeddings + vision.
node dist\polymath.cjs
```

Refresh, model swap, doctor checks, all wired in:

```powershell
node dist\polymath.cjs llm status     # token freshness + account id
node dist\polymath.cjs llm models     # what your account can call (24h cache)
node dist\polymath.cjs llm logout     # wipe the local tokens
node dist\polymath.cjs doctor         # codex_auth check shows up here
```

**Posture:** Tokens stay on your machine in `~/.polymath/codex-auth.json` (mode 0600). Polymath never proxies your account, pools tokens, or batches requests across users. This is the same posture Codex CLI itself uses — the upstream tolerates legitimate desktop clients on personal accounts. Don't share your token; you're the only person who should be using it.

---

## Configuration

Polymath reads `~/.polymath/polymath.json` (auto-created on first boot). Key settings:

```json
{
  "llm": {
    "provider": "ollama",
    "model": "gpt-oss:20b",
    "base_url": "http://localhost:11434/v1"
  },
  "channels": {
    "telegram": { "token": "...", "enabled": true, "allowed_users": ["<your-id>"] }
  },
  "memory": {
    "consolidation_model": "gpt-oss:20b",
    "embedding_model": "nomic-embed-text"
  }
}
```

You can hot-swap providers from the Settings tab in the UI without restarting.

---

## CLI

```
polymath                       # boot gateway + REPL
polymath agent "your task"     # one-shot
polymath init <path>           # create workspace
polymath brands list/add/remove
polymath media seed <path>     # catalog files
polymath media stats           # show counts
polymath gpu status            # current lease state
polymath gpu claim <owner>     # take the GPU (releases on Ctrl+C)
polymath doctor                # diagnostic
polymath show-token            # auth token
polymath skills install <name> # from agentskills.io
polymath mcp serve             # expose Polymath's tools as MCP server
```

---

## Honest comparisons

| | Polymath | Hermes Agent | OpenClaw | ChatRTX |
|---|---|---|---|---|
| Open source | MIT | yes | yes | NVIDIA license |
| Local LLM support | ✅ all OpenAI-compat | ✅ | ✅ | ✅ (TRT-LLM) |
| Tool calling / ReAct | ✅ 70+ tools | ✅ | ✅ | ❌ |
| MCP client | ✅ | ✅ | partial | ❌ |
| MCP server | ✅ | ❌ | ❌ | ❌ |
| Skills | ✅ user-private | ✅ marketplace | basic | ❌ |
| Cron / scheduled agents | ✅ | ✅ | ❌ | ❌ |
| Multi-channel (Telegram/Discord/Email) | ✅ | ✅ | ❌ | ❌ |
| Cooperative GPU arbitration | ✅ | ❌ | ❌ | ❌ |
| Per-skill model swap | ✅ | ❌ | ❌ | ❌ |
| Text memory (episodic + semantic) | ✅ | ✅ | basic | basic (text RAG) |
| **Media memory (video/photo CLIP)** | ✅ **CUDA+TRT C++** | ❌ | ❌ | ✅ (text-grouped images only) |
| **Workflow trace (analyze→edit→post)** | ✅ | ❌ | ❌ | ❌ |
| **Brand/category path inference** | ✅ | ❌ | ❌ | ❌ |

If you're a developer who wants the most polished agent loop with the most provider plugins, Hermes is more mature. If you're a content creator who needs an agent that knows your video catalog, Polymath is the only option.

---

## Status

- **v0.1.0** — early. Architecture is solid: 240 tests, build hash on every UI deploy, real diagnostic, streaming SSE chat, real embeddings, mid-session compression all working.
- Polish, broader provider testing, AMD/Apple Silicon vision path, and a public skills marketplace are not in v0.1.
- If you find bugs, open an issue with `polymath doctor` output attached.

---

## Support

Polymathes is MIT and always will be. If it's useful to you and you want to throw a few bucks at keeping it going, [**sponsor on GitHub**](https://github.com/sponsors/bkennedyshit). No pressure — stars, PRs, and feedback help just as much.

---

## License

MIT. See [LICENSE](LICENSE). The whole point is adoption — use it, fork it, ship your own thing on top of it.

---

## About

Built by [Bill Kennedy](https://github.com/bkennedyshit) — content creator and systems engineer. Polymath is the agent I built because the existing ones didn't know my content workflow. If you build something cool with it, open an issue or DM. I want to see it.
