# Architecture

## Overview

Polymath core-node is a TypeScript agent runtime that orchestrates LLM-driven task execution with tool calling, memory, and multi-transport I/O.

## Module Map

```
src/
├── cli.ts              Entry point (commander CLI)
├── main.ts             Boot sequence, RuntimeContext, gateway start
├── config/             Config loading + Zod schema
├── db/                 SQLite (better-sqlite3) + migrations
├── log.ts              Pino logger factory
├── audit/              Tool-call audit writer
├── llm/                LLM adapters (OpenAI, Anthropic)
├── memory/             Working, episodic, semantic, procedural memory
├── orchestrator/       ReAct loop, streaming, context management
├── tools/              ToolRegistry, ToolRouter, discovery, MCP client/server
├── skills/             Skill discovery from SKILL.md files
├── security/           Pairing, approval queue, DM policy
├── sandbox/            Execution policy (host/docker/firejail)
├── sessions/           Sub-agent spawning
├── agents/             Agent registry + router
├── cron/               Cron scheduler (croner)
├── transports/         CLI, Telegram, Discord, Signal, Email, Webchat
├── gateway/            Hono HTTP server + auth middleware
├── voice/              STT, TTS, wake word detection
├── ui/                 Single-page control panel (React, served by gateway)
└── onboard/            First-run setup wizard
```

## Data Flow

```
User Input (CLI / Telegram / Web / Discord / Email)
        │
        ▼
┌─────────────────────┐
│  Transport Layer     │  Normalizes input → {channel, senderId, text, sessionId}
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  RuntimeContext      │  runTask(text, sessionId)
│  (main.ts)          │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Orchestrator Loop   │  ReAct: think → tool_call → observe → repeat
│  (orchestrator/)     │  Manages token budget, iteration cap
└────────┬────────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌────────────┐
│  LLM   │ │ ToolRouter │ → ToolRegistry (builtin) + McpRegistry (external)
└────────┘ └────────────┘
                  │
                  ▼
         ┌───────────────┐
         │  Audit Writer  │  Records every tool call
         └───────────────┘
```

## Key Design Decisions

1. **Single-process, multi-transport.** One Node.js process handles all channels. Transports are thin adapters that normalize I/O.

2. **MCP for extensibility.** External capabilities (media-memory, virtual-input) run as separate MCP servers connected via stdio. The runtime discovers their tools at startup.

3. **SQLite for state.** Sessions, audit, cron, pairings, and episodic memory all live in a single SQLite file (`~/.polymath/polymath.db`). No external database required.

4. **Zod-validated config.** The config schema is defined in code. Invalid config fails fast at boot.

5. **Tool-level sandboxing.** Each tool can be routed to host, Docker, WSL, or firejail execution based on policy.

6. **Approval queue.** Dangerous tool calls can require human approval before execution.

7. **Streaming-first LLM.** The orchestrator supports streaming responses for real-time output to transports.
