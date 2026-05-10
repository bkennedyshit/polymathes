# Polymath Framework Design

This doc explains how the pieces fit together and what's intentionally missing.

## The thesis in one sentence

**Content creation, software development, and business automation are the same problem — make a thing, distribute it, respond to signal — and agent frameworks today only automate the "make code" slice of it.**

## The problem with existing frameworks

| Framework | What it does well | What it misses |
|---|---|---|
| OpenClaw / Agent-Zero | Autonomous task loops, delegation, CPU-friendly | Assumes cloud API, not GPU-local. Text/code only. |
| Hermes / Nous | Lean tool-call protocol, function calling | No media, no desktop automation, library not runtime. |
| Claude Code / Codex | Tight IDE integration, code-aware | Locked to one vendor, code-only, no media memory. |
| ChatRTX (deprecated) | Local RTX, RAG over docs | Reference demo, not a runtime. Deprecated 2026-01-21. |
| LangChain / LlamaIndex | Ecosystem, every integration | Wrappers on top of APIs, slow, Python-only. |

The gap: **a runtime that treats GPU-local media reasoning as first-class, exposes everything as MCP tools, and ships with the primitives creators actually need (desktop automation, IDE bridge, content pipelines).**

## Core runtime design

### Responsibilities

1. **Task intake** from any transport (CLI, web, Telegram, voice)
2. **Decomposition** — break user goals into sub-tasks
3. **Skill selection** — pick the right capability/tool/agent for each sub-task
4. **Delegation** — call an MCP tool, spawn a subagent, or bridge to an external agent (via ide-bridge)
5. **Memory** — short-term (context), episodic (what happened last session), long-term (indexed via media-memory)
6. **Sandbox policy** — what the agent can touch, audit log of every tool call
7. **Result synthesis** — hand the answer back to the transport

### Language choice

**Core runtime: Rust or TypeScript.** Not C++ (too heavy for orchestration), not Python (GIL, perf).

Leaning Rust because:
- Single binary deploy
- Cargo ecosystem covers most needs
- Tokio handles the async multi-transport + subprocess orchestration well
- Aligns with the "compiled, fast, local" brand of the capabilities

TypeScript is plan B if the MCP ecosystem stays TS-heavy.

### MCP as the integration layer

Every capability is an MCP server. The core runtime is an MCP client. This means:

- Capabilities are process-isolated (crash in one doesn't take down the framework)
- External agents (Claude Code, Cursor, any MCP-compatible client) can call Polymath capabilities directly
- Polymath can call any existing MCP server from the ecosystem
- Swapping the core runtime later doesn't invalidate the capability layer

### Directory layout (current)

```
polymath/
├── core-ts/                     # TypeScript/Deno runtime (v1, primary)
│   └── src/
│       ├── main.ts              # entrypoint
│       ├── orchestrator/        # ReAct loop + episodes + memory
│       ├── mcp/                 # client, registry, router
│       ├── llm/                 # adapter + OpenAI-compat impl
│       ├── transports/          # CLI (REPL + one-shot)
│       ├── builtin/             # core.* tools
│       ├── config/              # config + policy loading
│       └── audit.ts             # audit writer
│
├── core-rust/                   # Rust runtime (v2, same contract)
│   └── crates/
│       ├── polymath-core/       # main binary
│       ├── polymath-adapter-api/       # stable C-ABI for LLM plugins
│       ├── polymath-adapter-openai/
│       └── polymath-adapter-anthropic/
│
├── capabilities/
│   ├── media-memory/            # C++ CLIP-based semantic search (was omni-search)
│   ├── virtual-input/           # Python (Linux), C# or C++ (Windows driver)
│   └── ide-bridge/              # TypeScript (CDP is JS-native)
│
├── .kiro/specs/
│   ├── polymath-core-ts/
│   ├── polymath-core-rust/
│   └── media-memory-completion/
│
├── docs/
│   └── FRAMEWORK.md             # This file
│
└── README.md
```

**Rule:** both `core-ts/` and `core-rust/` target the same CLI surface, config schema, and MCP capability protocol. Users pick one to run; capabilities work identically against either. When the Rust runtime ships feature-complete parity, the TS runtime remains available as a lightweight alternative.

## Deployment profiles

### Profile A: Creator workstation (primary)

- Native binaries (no Docker)
- All capabilities local on one machine
- GPU is the local RTX 3090 / 4090 / 5090
- Transport: CLI + Web UI + optional Telegram bot for remote commands
- Example user: BMX content creator editing footage, posting across YouTube/Reels/TikTok

### Profile B: Cloud GPU + remote workstation (advanced)

- Core runtime runs on the cloud GPU box (e.g. RunPod, Lambda Labs)
- `media-memory` runs there too (GPU-heavy)
- `virtual-input` + `ide-bridge` run on the local workstation, connected via mTLS socket
- Transport: Telegram, SSH, or the Web UI tunneled through the cloud
- Example user: dev who wants a massive cloud GPU for indexing their entire archive but still wants the agent to drive their local VSCode

### Profile C: Headless CI / batch (secondary)

- Docker container with `media-memory` only
- Indexes a mounted volume, exposes search over HTTP
- Example user: team server that indexes a shared content library

## What's intentionally out of scope

- **Building a new LLM.** Polymath uses what exists — local llama.cpp or remote API.
- **Browser engine from scratch.** CEF or Tauri's webview, not a fork.
- **Generic any-app cloud deployment.** The media-memory profile benefits from GPU locality; optimizing for Lambda-style serverless undermines the thesis.
- **Enterprise features (SSO, RBAC, multi-tenant).** Out of scope for v1. Add if/when a user asks for it.

## What ships in v1

Ordered by priority:

1. `media-memory` building and runnable on Windows + Linux with TensorRT
2. `virtual-input` Linux functional (done), Windows via Interception
3. `ide-bridge` extracted from monorepo, published as MCP server
4. `core` runtime skeleton — MCP broker, task dispatch, single CLI transport
5. One end-to-end demo: "Find all BMX clips where I do a barspin → export them as a highlight reel"

Everything else (content-pipeline, voice-loop, web UI, Telegram) is v2+.

## Why this read as a portfolio piece

A recruiter / engineering lead scanning the README sees:
- A specific, defensible thesis (media-native + creator+dev overlap)
- Real implementation in a hard language (C++ + CUDA)
- A novel primitive (kernel-level virtual input) most agents don't have
- MCP compatibility (shows understanding of where the ecosystem is going)
- Clear boundaries and priorities (out-of-scope section)
- Evidence of shipping something, not just planning

Even if only `media-memory` is fully functional on day 1, the framework scaffolding and capability READMEs make it legible as "this person is building a platform, not a toy."
