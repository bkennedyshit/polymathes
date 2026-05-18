/**
 * Codex Responses adapter — speaks the ChatGPT-subscription Codex
 * backend (`https://chatgpt.com/backend-api/codex/responses`) while
 * implementing Polymath's standard `LlmAdapter` interface so the
 * orchestrator loop is unaware of the underlying transport.
 *
 * Differences from the OpenAI Chat Completions adapter:
 *
 *   - Auth comes from the Codex token store, not a static API key.
 *     `ensureFreshToken()` is called before every request; `forceRefresh()`
 *     drives the 401-retry path.
 *   - Endpoint is `/responses` and the request body uses `input[]`
 *     instead of `messages[]`.
 *   - Streaming events follow the Responses-flavoured SSE protocol
 *     (`response.output_text.delta`, `response.tool_calls.delta`,
 *     `response.completed`, `response.error`).
 *   - `OpenAI-Account-Id` and `User-Agent: Polymath/<version>` are
 *     required headers — the upstream rejects requests without the
 *     account header even when the bearer token is valid.
 *
 * See `.kiro/specs/polymath-codex-auth/requirements.md` (R4.*, R3.2-3,
 * R7.3) and `design.md` (R4 — Adapter shape) for the source of truth.
 */

import { ensureFreshToken, forceRefresh } from "./auth_refresh.js";
import {
  CodexAuthExpired,
  type CodexResponsesRequest,
  type CodexResponsesStreamEvent,
  type CodexTokens,
} from "./responses_protocol.js";
import type {
  ChatDelta,
  ChatMessage,
  CompletionOptions,
  LlmAdapter,
  LlmTool,
  ToolCall,
} from "../types.js";

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

/** Default model when neither config nor per-call opts pin one.
 *  ChatGPT-account-tier model. Codex CLI uses `gpt-5.5` as the default
 *  when authenticated via a ChatGPT subscription (verified from a
 *  rollout file at `~/.codex/sessions/.../rollout-*.jsonl`). The
 *  legacy / API-only ids like `gpt-5` and `gpt-5-codex` are blocked at
 *  the upstream with a 400:
 *  `The 'gpt-5' model is not supported when using Codex with a
 *  ChatGPT account.`. Per-call `opts.model` still wins. */
const DEFAULT_MODEL = "gpt-5.5";

/** Max attempts including the initial call when retrying on 429s. */
const MAX_RETRY_ATTEMPTS = 3;

export interface OpenAiCodexConfig {
  /** Polymath version, surfaced in the `User-Agent` header. */
  version: string;
  /** Default model for the adapter; per-call `opts.model` overrides. */
  model?: string;
  /** Default streaming mode; per-call `opts.stream` overrides. */
  streaming?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Map a Polymath `ChatMessage[]` to the Codex Responses `input[]`
 * shape. The Responses input is a typed item list, NOT just role+content:
 *
 *   - `system` messages: hoisted into top-level `instructions`, NOT
 *     emitted here.
 *   - `user` / `assistant` text messages: `{role, content}` items.
 *   - Assistant turns that emitted tool calls: each call becomes an
 *     `{type: "function_call", call_id, name, arguments}` item. The
 *     `role: "assistant"` form with embedded JSON is rejected by the
 *     upstream with `400 "Invalid value: 'tool'"` etc.
 *   - Tool results (`role: "tool"`): `{type: "function_call_output",
 *     call_id, output}` items. The upstream rejects `role: "tool"`
 *     with `400 "Invalid value: 'tool'. Supported values are
 *     'assistant', 'system', 'developer', and 'user'."`.
 */
function toResponsesInput(
  messages: ChatMessage[],
  knownToolNames: Set<string>,
): CodexResponsesRequest["input"] {
  const out: CodexResponsesRequest["input"] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // hoisted into instructions
    if (m.role === "tool") {
      // Tool result → function_call_output item. tool_call_id is the
      // call_id the model produced earlier; we pass it through verbatim.
      // Fallback to a synthetic id so the upstream's `min length 1`
      // validation doesn't trip when something stripped tool_call_id
      // out of the ChatMessage upstream.
      out.push({
        type: "function_call_output",
        call_id: m.tool_call_id || `call_${Math.random().toString(36).slice(2, 14)}`,
        output: m.content ?? "",
      });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      // Optional preamble text from the same turn (rare in practice
      // since most models emit either text OR tool calls per turn).
      // Skip empty strings so we don't trip the upstream's
      // "Invalid value: empty" validation.
      if (m.content && m.content.trim().length > 0) {
        out.push({ role: "assistant", content: m.content });
      }
      for (const tc of m.tool_calls) {
        const callId = tc.id || `call_${Math.random().toString(36).slice(2, 14)}`;
        out.push({
          type: "function_call",
          // Sanitize the name to match what we sent in tools[]
          // earlier — Codex matches by name to validate the call_id.
          name: sanitizeToolName(tc.function.name),
          call_id: callId,
          arguments: tc.function.arguments ?? "",
        });
      }
      continue;
    }
    out.push({ role: m.role, content: m.content ?? "" });
  }
  // Suppress the "knownToolNames param is unused" warning by referencing it.
  // The set is kept on the call signature for symmetry with the parsers, in
  // case a future Responses revision asks us to validate function-call names
  // here too.
  void knownToolNames;
  return out;
}

/**
 * Concatenate every `system` message in order into a single
 * `instructions` string. Codex Responses requires this field to be
 * non-empty; when the caller hasn't supplied one we fall back to a
 * minimal Polymath identifier so the upstream stops complaining.
 */
function extractInstructions(messages: ChatMessage[]): string {
  const sys: string[] = [];
  for (const m of messages) {
    if (m.role === "system" && m.content) sys.push(m.content);
  }
  if (sys.length === 0) {
    return "You are a helpful AI assistant operating inside Polymath.";
  }
  return sys.join("\n\n");
}

/**
 * Sanitize Polymath tool names so they match the Codex Responses API
 * pattern `^[a-zA-Z0-9_-]+$`. Polymath uses dotted namespaces (e.g.
 * `media.query`, `gpu.status`) which the upstream rejects with
 * `"Invalid 'tools[0].name': string does not match pattern"`. We keep
 * the mapping reversible so tool-call results from the model can be
 * routed back to the original handler.
 */
function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Reverse the sanitization. Codex echoes the sanitized name back in
 * `response.tool_calls.delta` events; we restore the dotted form so
 * `ToolRouter.invoke` finds the handler. Pure heuristic: we don't keep
 * a per-call mapping, so any underscore that wasn't a dot originally
 * gets converted back. This is safe in practice because Polymath tool
 * names always have at most one dot per segment.
 */
function desanitizeToolName(name: string, knownTools: Set<string>): string {
  if (knownTools.has(name)) return name;
  // Try replacing each `_` with `.` greedily. The first hit wins.
  for (let i = 0; i < name.length; i++) {
    if (name[i] !== "_") continue;
    const candidate = name.slice(0, i) + "." + name.slice(i + 1);
    if (knownTools.has(candidate)) return candidate;
  }
  return name;
}

/**
 * Transform Polymath's `LlmTool` (Chat Completions shape) into the
 * Codex Responses tools shape. Chat Completions nests `name` /
 * `description` / `parameters` under `function`; Responses flattens
 * them to the tool's top level. The upstream returns 400
 * `"Missing required parameter: 'tools[0].name'"` if we pass through
 * the nested form.
 */
function toResponsesTools(tools: LlmTool[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    name: sanitizeToolName(t.function.name),
    description: t.function.description,
    parameters: t.function.parameters,
  }));
}

interface ToolCallBuf {
  id: string;
  call_id?: string;
  name: string;
  args: string;
}

/**
 * Streaming tool-call buffer. Codex Responses emits tool calls across
 * multiple events:
 *
 *   - `response.output_item.added` (with `item.type === "function_call"`):
 *     announces a new call. Carries the item id, call_id, and function
 *     name. Often arrives before any arguments.
 *   - `response.function_call_arguments.delta`: streams the JSON
 *     arguments string in chunks. Tracked by `item_id`.
 *   - `response.function_call_arguments.done`: terminator with the full
 *     concatenated `arguments` string. We keep delta-accumulated value
 *     when present and fall back to this on terminate.
 *   - `response.output_item.done` (with `item.type === "function_call"`):
 *     final state of the item. Carries `arguments` + `call_id` again.
 *
 * We index buffers by `item_id` rather than the spec's `output_index`
 * because the upstream is consistent about `item_id` and not always
 * about index ordering.
 */
function assembleToolCalls(buf: Record<string, ToolCallBuf>): ToolCall[] {
  return Object.values(buf).map((tc) => ({
    id: tc.call_id ?? tc.id,
    type: "function" as const,
    function: { name: tc.name, arguments: tc.args },
  }));
}

export class OpenAiCodexAdapter implements LlmAdapter {
  /**
   * Last set of tokens we successfully resolved. Cached so
   * `getAccountId()` doesn't have to hit disk; the field is refreshed
   * each time `ensureFreshToken()` runs.
   */
  private cachedTokens: CodexTokens | null = null;

  constructor(private cfg: OpenAiCodexConfig) {}

  /**
   * Account id used for the `OpenAI-Account-Id` header. Doctor checks
   * (T9) and the UI status endpoint (T10) read this so they can
   * surface "signed in as <account>" without re-loading the auth store
   * themselves. Returns `null` until the adapter has made (or attempted)
   * its first call.
   */
  getAccountId(): string | null {
    return this.cachedTokens?.account_id ?? null;
  }

  async *complete(
    messages: ChatMessage[],
    tools: LlmTool[],
    opts?: CompletionOptions,
  ): AsyncIterable<ChatDelta> {
    const stream = opts?.stream ?? this.cfg.streaming ?? false;
    // Track original tool names so we can reverse the sanitization in
    // streaming + JSON responses without keeping a separate per-call map.
    const knownToolNames = new Set(tools.map((t) => t.function.name));
    const body: CodexResponsesRequest = {
      model: opts?.model ?? this.cfg.model ?? DEFAULT_MODEL,
      instructions: extractInstructions(messages),
      input: toResponsesInput(messages, knownToolNames),
      // ChatGPT-subscription auth does not permit server-side storage
      // of the conversation; the upstream returns 400
      // `"Store must be set to false"` if `store` is omitted or true.
      // Polymath holds its own conversation state, so this is also
      // semantically correct.
      store: false,
      stream,
    };
    if (tools.length) body.tools = toResponsesTools(tools);

    let tokens = await ensureFreshToken();
    this.cachedTokens = tokens;
    let didForceRefresh = false;

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.access_token}`,
        "OpenAI-Account-Id": tokens.account_id,
        "User-Agent": `Polymath/${this.cfg.version}`,
      };
      if (stream) headers["Accept"] = "text/event-stream";

      const res = await fetch(RESPONSES_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: opts?.signal,
      });

      if (res.status === 401) {
        // Drain so the socket can be reused.
        try { await res.body?.cancel(); } catch { /* swallow */ }
        if (didForceRefresh) {
          // We already refreshed once and STILL got 401 — the refresh
          // token itself is dead. Surface the auth-expired error so
          // the gateway / CLI can prompt re-login.
          throw new CodexAuthExpired(
            "Codex auth rejected after refresh; re-run `polymath llm login`.",
          );
        }
        tokens = await forceRefresh();
        this.cachedTokens = tokens;
        didForceRefresh = true;
        // Don't burn an attempt on the auth retry — try the same
        // attempt index again with the new token.
        attempt--;
        continue;
      }

      if (res.status === 429) {
        try { await res.body?.cancel(); } catch { /* swallow */ }
        const retryAfter = Number(res.headers.get("retry-after") ?? "5") * 1000;
        await sleep(retryAfter);
        continue;
      }

      if (res.status >= 500) {
        try { await res.body?.cancel(); } catch { /* swallow */ }
        lastErr = new Error(`Codex error: HTTP ${res.status}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }

      if (!res.ok) {
        // 4xx that isn't 401/429 — surface the body so the user has
        // some chance of diagnosing it (model doesn't exist, plan
        // doesn't allow it, etc.).
        let detail = "";
        try { detail = await res.text(); } catch { /* swallow */ }
        const truncated = detail.length > 500 ? detail.slice(0, 500) + "…" : detail;
        throw new Error(
          `Codex error: HTTP ${res.status}${truncated ? ` — ${truncated}` : ""}`,
        );
      }

      if (stream) {
        yield* this.parseSSE(res, knownToolNames);
      } else {
        yield* this.parseJson(res, knownToolNames);
      }
      return;
    }

    throw lastErr ?? new Error("Codex request failed after retries");
  }

  /**
   * Non-streaming path. The Codex backend mirrors the Responses event
   * union but as a single JSON object: an `output_text` field for
   * plain content, `tool_calls` for assembled calls, and a `usage`
   * block. We yield one delta with content/tool_calls and a second
   * delta with usage so the orchestrator's loop sees the same shape
   * the OpenAI adapter produces.
   */
  private async *parseJson(res: Response, knownToolNames: Set<string>): AsyncIterable<ChatDelta> {
    const json = (await res.json()) as any;
    const usage = json?.response?.usage ?? json?.usage;
    const finishReason: string | undefined =
      json?.response?.finish_reason ?? json?.finish_reason;

    // Tool calls may come back either as `tool_calls` or nested under
    // `response`. Accept both since the upstream isn't fully stable.
    const rawCalls: any[] | undefined =
      json?.tool_calls ?? json?.response?.tool_calls;
    if (Array.isArray(rawCalls) && rawCalls.length > 0) {
      const tool_calls: ToolCall[] = rawCalls.map((tc: any) => {
        const sanitized = tc?.function?.name ?? tc?.name ?? "";
        return {
          id: tc.id ?? "",
          type: "function" as const,
          function: {
            name: desanitizeToolName(sanitized, knownToolNames),
            arguments:
              typeof tc?.function?.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc?.function?.arguments ?? tc?.arguments ?? {}),
          },
        };
      });
      yield { tool_calls, finish_reason: finishReason ?? "tool_calls" };
    } else {
      const content: string =
        json?.output_text ??
        json?.response?.output_text ??
        json?.content ??
        "";
      yield { content, finish_reason: finishReason ?? "stop" };
    }

    if (usage) {
      yield {
        usage: {
          prompt_tokens: usage.input_tokens ?? 0,
          completion_tokens: usage.output_tokens ?? 0,
        },
      };
    }
  }

  /**
   * Streaming path. SSE frames are `data: <json>\n\n`. We dispatch on
   * the parsed event's `type` discriminator. The Codex Responses
   * protocol is similar to but not identical with the public OpenAI
   * Responses API; we model the variants we've observed live:
   *
   * Text path:
   *   - `response.output_text.delta` → emit a `content` delta directly.
   *   - `response.output_text.done` → terminator; we do nothing (the
   *     deltas already accumulated).
   *
   * Tool-call path (the only path the model takes when it has tools):
   *   - `response.output_item.added` with `item.type === "function_call"`
   *     → register a new tool buffer keyed by `item_id`.
   *   - `response.function_call_arguments.delta` → append to the
   *     buffer's args string.
   *   - `response.function_call_arguments.done` → optional terminator
   *     carrying the full arguments; we accept it as ground truth so
   *     missing-delta cases still produce valid JSON.
   *   - `response.output_item.done` with `item.type === "function_call"`
   *     → also carries final arguments + call_id; refresh the buffer.
   *
   * Lifecycle:
   *   - `response.completed` → emit final delta (`finish_reason` +
   *     usage if present). If tool calls accumulated, finish_reason
   *     defaults to `"tool_calls"`.
   *   - `response.error` → throw with the upstream message.
   *
   * Unknown event types pass through silently — forward-compatible
   * with future Codex protocol additions.
   */
  private async *parseSSE(res: Response, knownToolNames: Set<string>): AsyncIterable<ChatDelta> {
    if (!res.body) {
      throw new Error("Codex streaming response had no body");
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const toolBufs: Record<string, ToolCallBuf> = {};

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      // SSE separates events by blank lines, but the simpler line-by-line
      // split mirrors what the OpenAI adapter does and is robust against
      // chunk boundaries that fall inside `data: <json>` lines because
      // we keep the trailing partial in `buf`.
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (process.env.DEBUG_CODEX === "1") {
          // eslint-disable-next-line no-console
          console.log("[codex-sse]", line.slice(0, 200));
        }
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;
        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          // Malformed frame — skip rather than crash the stream.
          continue;
        }
        switch (event.type) {
          case "response.output_text.delta": {
            const delta = event.delta;
            if (typeof delta === "string" && delta) {
              yield { content: delta };
            }
            break;
          }
          case "response.output_text.done": {
            // Text already streamed via deltas; this is a terminator
            // we keep around in case future Codex versions stop
            // emitting deltas in favor of a single done frame.
            // No-op for now.
            break;
          }
          case "response.output_item.added": {
            // Announces a new top-level item. Function calls register
            // a new tool-call buffer keyed by item_id.
            const item = event.item;
            if (item?.type === "function_call") {
              const itemId: string = item.id ?? `idx-${event.output_index ?? 0}`;
              toolBufs[itemId] = {
                id: itemId,
                call_id: item.call_id,
                name: item.name ?? "",
                args: typeof item.arguments === "string" ? item.arguments : "",
              };
            }
            break;
          }
          case "response.function_call_arguments.delta": {
            const itemId: string = event.item_id ?? `idx-${event.output_index ?? 0}`;
            if (!toolBufs[itemId]) {
              toolBufs[itemId] = { id: itemId, name: "", args: "" };
            }
            if (typeof event.delta === "string") {
              toolBufs[itemId].args += event.delta;
            }
            break;
          }
          case "response.function_call_arguments.done": {
            const itemId: string = event.item_id ?? `idx-${event.output_index ?? 0}`;
            if (!toolBufs[itemId]) {
              toolBufs[itemId] = { id: itemId, name: "", args: "" };
            }
            // Trust the terminator's full arguments string when present
            // — guards against any delta we might have missed.
            if (typeof event.arguments === "string" && event.arguments) {
              toolBufs[itemId].args = event.arguments;
            }
            break;
          }
          case "response.output_item.done": {
            const item = event.item;
            if (item?.type === "function_call") {
              const itemId: string = item.id ?? `idx-${event.output_index ?? 0}`;
              if (!toolBufs[itemId]) {
                toolBufs[itemId] = { id: itemId, name: "", args: "" };
              }
              if (item.name) toolBufs[itemId].name = item.name;
              if (item.call_id) toolBufs[itemId].call_id = item.call_id;
              if (typeof item.arguments === "string" && item.arguments) {
                toolBufs[itemId].args = item.arguments;
              }
            }
            break;
          }
          case "response.completed": {
            const u = event.response?.usage;
            const assembled = assembleToolCalls(toolBufs).map((tc) => ({
              ...tc,
              function: {
                name: desanitizeToolName(tc.function.name, knownToolNames),
                arguments: tc.function.arguments,
              },
            }));
            const finish_reason =
              event.response?.finish_reason
              ?? (assembled.length > 0 ? "tool_calls" : "stop");
            if (assembled.length > 0) {
              yield { tool_calls: assembled, finish_reason };
            } else {
              yield { finish_reason };
            }
            if (u) {
              yield {
                usage: {
                  prompt_tokens: u.input_tokens ?? 0,
                  completion_tokens: u.output_tokens ?? 0,
                },
              };
            }
            return;
          }
          case "response.error": {
            const msg = event.error?.message ?? "Codex stream error";
            throw new Error(`Codex error: ${msg}`);
          }
          default:
            // Forward-compatible: any unknown event is ignored.
            break;
        }
      }
    }

    // Stream ended without a `response.completed` frame. Flush any
    // accumulated tool calls so the orchestrator can still act on them.
    const assembled = assembleToolCalls(toolBufs).map((tc) => ({
      ...tc,
      function: {
        name: desanitizeToolName(tc.function.name, knownToolNames),
        arguments: tc.function.arguments,
      },
    }));
    if (assembled.length > 0) {
      yield { tool_calls: assembled, finish_reason: "tool_calls" };
    }
  }
}
