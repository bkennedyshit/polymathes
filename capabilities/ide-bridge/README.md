# ide-bridge

Drive other agents (VSCode, Kiro, Cursor, Claude Code, Codex) from your agent. Uses the Chrome DevTools debug port that every Electron-based IDE exposes.

## Status

**Functional** (in your monorepo — to be imported). Proven pattern: open the IDE via Playwright with `--remote-debugging-port`, attach CDP, send prompts programmatically.

## Why this exists

**The meta-agentic insight.** Every agent framework has a blind spot: it can write code, but it can't drive another agent's UI to write code faster. An agent using ide-bridge can:

- Delegate a coding task to Claude Code inside VSCode
- Supervise the subagent's output and auto-approve continue/retry
- Tell Kiro "make this spec → design → tasks" and watch it run
- Call Codex for a specific refactor, return to Claude Code for integration

It turns every paid agent subscription (Claude Max, GPT Plus, Cursor Pro) into a callable subagent. Pay once, delegate everywhere.

## Architecture

```
Agent layer (you / Polymath core)
        │  "implement the login flow in this file"
        ▼
ide-bridge
        │  CDP: Runtime.evaluate / Input.dispatchKeyEvent
        ▼
VSCode (electron)
        │  launched with --remote-debugging-port=9222
        ▼
Claude Code extension
        │  runs the task
        ▼
Results scraped back from the DOM
```

## MCP tool surface (planned)

### `ide_open`
Launch an IDE instance with CDP enabled.
```json
{
  "ide": "vscode|kiro|cursor",
  "workspace": "string (path)",
  "cdp_port": "number (optional, default 9222)"
}
```

### `ide_send_prompt`
Send a message to the IDE's active agent (Claude Code, Kiro chat, Cursor chat).
```json
{
  "cdp_port": "number",
  "agent": "claude-code|kiro|cursor-chat",
  "prompt": "string"
}
```

### `ide_wait_for_idle`
Block until the agent finishes (detects "generating..." → "idle" transition).
```json
{
  "cdp_port": "number",
  "timeout_seconds": "number (optional, default 300)"
}
```

### `ide_read_output`
Scrape the most recent agent response from the chat panel.
```json
{ "cdp_port": "number" }
```

### `ide_approve` / `ide_reject`
Click continue/reject buttons for agents with human-in-the-loop steps.
```json
{ "cdp_port": "number" }
```

## Integration pattern

```python
# Pseudocode — real implementation uses MCP
bridge.ide_open(ide="vscode", workspace="~/project", cdp_port=9222)
bridge.ide_send_prompt(9222, "claude-code", "add pagination to /users endpoint")
result = bridge.ide_wait_for_idle(9222, timeout_seconds=600)
output = bridge.ide_read_output(9222)
# feed `output` back into main agent's context
```

## Anti-detection

Most IDEs don't detect CDP attachment (they enable it themselves for extensions). The `virtual-input` capability is available for IDEs that do — use kernel-level events instead of CDP for button clicks.

## Import from monorepo

The existing implementation is being extracted from a private workspace. TODO: extract the minimum viable CDP driver + prompt adapters here.
