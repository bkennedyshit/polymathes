# Codex (ChatGPT subscription) auth — smoke test notes

End-to-end verification of the `openai-codex` provider against a real
ChatGPT account, run on 2026-05-17 against build hash `899244a0`.

This document records the gotchas we hit while bringing the integration
up against the live `chatgpt.com/backend-api/codex/responses` endpoint
so future maintainers don't re-discover them.

## Environment

- Polymath `0.1.1`
- Account: ChatGPT Plus (single seat)
- Local fleet: Ollama at `http://localhost:11434/v1`
  (nomic-embed-text + qwen2.5vl + gpt-oss:20b)
- OS: Windows 11, Node 22

## Pre-flight

1. `polymath llm import-codex --yes` — copies tokens from the user's
   Codex CLI install at `~/.codex/auth.json` to
   `~/.polymath/codex-auth.json` (mode 0600).
2. Edit `~/.polymath/polymath.json`:
   ```json
   {
     "llm": {
       "provider": "openai-codex",
       "model": "gpt-5.5",
       "streaming": true,
       "context_window": 200000
     },
     "memory": {
       "embedder_base_url": "http://localhost:11434/v1",
       "embedding_model": "nomic-embed-text"
     }
   }
   ```
3. Boot: `node dist/polymath.cjs`. Confirm in the log:
   - `gpu broker online` (Ollama still serves embeddings + vision)
   - `polymath gateway listening on http://localhost:18789`
4. `polymath doctor` should show:
   - `Codex auth` green (`account <id>, last refresh <N> min ago`)
   - `LLM (openai-codex)` green
   - `Embedder` green (because the local fleet is still wired)

## Gotchas we hit and fixed (in order)

Each one earned a 400 from the upstream that wasn't documented anywhere
public — the responses below come from instrumenting the live SSE
stream with `DEBUG_CODEX=1`.

### 1. `gpt-5` and `gpt-5-codex` are blocked on ChatGPT-account auth

> `"The 'gpt-5' model is not supported when using Codex with a ChatGPT account."`

Both `gpt-5` and `gpt-5-codex` are API-tier-only model ids. The
ChatGPT-account-tier slug for the Codex backend is
**`gpt-5.5`**, sourced from the user's `~/.codex/models_cache.json`.
Other valid slugs we observed for this account: `gpt-5.4`,
`gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2`. The `/v1/models` endpoint
is gated behind a Cloudflare challenge for non-browser User-Agents, so
we can't probe it directly — `polymath llm models` reads the cached
list and falls back to a hardcoded `["gpt-5.5", ...]` set.

### 2. `instructions` is required, not optional

> `{"detail":"Instructions are required"}`

The Codex Responses API rejects requests without a top-level
`instructions` string. System messages MUST be hoisted out of the
`input` array and concatenated into `instructions`.
`extractInstructions()` in `responses_adapter.ts` handles this; if no
system message is supplied we fall back to a neutral identifier.

### 3. `store: false` is required

> `{"detail":"Store must be set to false"}`

ChatGPT-subscription auth doesn't permit server-side storage of the
conversation. `store: false` is now sent on every request. This matches
Polymath's own architecture anyway — the orchestrator holds the full
history.

### 4. Tool definitions use the flattened shape, not Chat Completions nested

> `"Missing required parameter: 'tools[0].name'"`

Chat Completions: `{type: "function", function: {name, description, parameters}}`.
Codex Responses: `{type: "function", name, description, parameters}` —
flattened. `toResponsesTools()` performs the transform.

### 5. Tool names must match `^[a-zA-Z0-9_-]+$`

> `"Invalid 'tools[0].name': string does not match pattern"`

Polymath uses dotted namespaces (`media.stats`, `gpu.status`). The
upstream rejects any `.` in the function name.
`sanitizeToolName()` replaces non-conforming chars with `_`, and
`desanitizeToolName()` reverses the mapping when the model echoes a
sanitized name back so `ToolRouter.invoke()` finds the original handler.

### 6. SSE event names differ from public Responses API docs

The Codex backend emits **`response.function_call_arguments.delta`**
and friends, NOT `response.tool_calls.delta` we initially modeled.
Full event list we now handle:

- `response.created`, `response.in_progress`, `response.completed`
- `response.output_text.delta`, `response.output_text.done`
- `response.output_item.added` (item.type=`function_call`),
  `response.output_item.done`
- `response.function_call_arguments.delta`,
  `response.function_call_arguments.done`
- `response.error`

The first text smoke test came back with `[completed]` and zero
content because the adapter was looking for the wrong delta event.
This was caught by running with `DEBUG_CODEX=1` and dumping every SSE
line to stdout.

### 7. Tool results use `function_call_output`, NOT `role: "tool"`

> `"Invalid value: 'tool'. Supported values are 'assistant', 'system', 'developer', and 'user'."`

When sending a multi-turn conversation back to Codex, tool results
must be reshaped from
`{role: "tool", content, tool_call_id}` (Chat Completions) to
`{type: "function_call_output", call_id, output}`. Likewise, prior
assistant turns that emitted tool calls become a sequence of
`{type: "function_call", name, call_id, arguments}` items rather than
a single `role: "assistant"` blob with a JSON tool_calls field.

### 8. WorkingMemory was dropping `tool_calls` and `tool_call_id`

> `"No tool call found for function call output with call_id call_..."`

Pre-existing bug in `orchestrator/loop.ts` — `truncated` was built via
`(m) => ({role: m.role, content: m.content})`, stripping the tool-
calling fields. This was harmless for Ollama (which is forgiving
about pairings) but fatal for Codex. Fixed by:

1. Extending `memory/working.ts::Message` to carry `tool_calls`,
   `tool_call_id`, `name`.
2. Preserving those fields in both `for (const m of history)
   ctx.memory.add(...)` and the `truncated` projection.

This bug has been latent since v0.1; surfacing it via Codex is a net
win for any future strict-mode adapter (Anthropic w/ tools, Gemini
function calling, etc.).

## Final smoke test

Test 1 — plain text:

```
POST /api/chat   {"text":"Reply with only the word ALIVE."}
→ {"answer":"ALIVE","sessionId":"..."}   3.3s
```

Test 2 — single tool round-trip:

```
POST /api/chat   {"text":"Call media.stats and report total count."}
→ {"answer":"Your media catalog has 10 total items.","sessionId":"..."}   12.1s
```

Both tests passed. The 12s tool-roundtrip latency is attributable to
the network hop to OpenAI's edge plus the `media.stats` query; on
warm tokens we expect ~8s for a comparable call.

## Refresh + Doctor

- `last_refresh` is rewritten by `ensureFreshToken()` whenever the
  current value is older than 25 minutes; the adapter calls this
  before every request.
- `doctor` reports Codex auth as green if `last_refresh` is < 25 min,
  yellow if 25-60 min (refresh due on next call), red if > 60 min.
- `polymath llm status` prints the same triage data without making an
  upstream call.

## Production checklist

- ☑ tokens at file mode 0600
- ☑ no env-var leakage (we never `console.log(tokens)` outside DEBUG)
- ☑ refresh races are idempotent (Codex CLI + Polymath can both run)
- ☑ adapter throws `CodexAuthExpired` on permanent 401 — UI can
  surface a "re-login" banner via `/api/auth/codex/status`
- ☑ tool-name sanitization is reversible
- ☑ `function_call` ↔ `function_call_output` pairing is preserved
  through context truncation
