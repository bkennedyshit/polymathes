/**
 * T12 — acceptance + regression test.
 *
 * Validates the wiring that ties config.llm.provider to the
 * `OpenAiCodexAdapter`, plus the protocol invariants that broke
 * during the live smoke test (T5):
 *   - Provider switch produces a CodexAdapter (not the OpenAI fallback).
 *   - Request body has `instructions`, `store: false`, flattened tools,
 *     and sanitized tool names.
 *   - Tool round-trip reshapes `role: "tool"` ↔ `function_call_output`
 *     and preserves call_id pairings end-to-end.
 *
 * Each invariant has a comment pointing back to the gotcha in
 * `docs/codex-auth-smoke.md` so a future regression is easy to map
 * to the original 400 error it would re-introduce.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/llm/codex/auth_refresh.js", () => ({
  ensureFreshToken: vi.fn(),
  forceRefresh: vi.fn(),
}));

import { buildLlm } from "../src/main.js";
import { OpenAiCodexAdapter } from "../src/llm/codex/responses_adapter.js";
import { OpenAiAdapter } from "../src/llm/openai.js";
import { ensureFreshToken } from "../src/llm/codex/auth_refresh.js";
import type { ChatMessage, LlmTool } from "../src/llm/types.js";

const FRESH_TOKENS = {
  access_token: "access-fresh",
  id_token: "id-fresh",
  refresh_token: "refresh-fresh",
  account_id: "acct_test",
};

function streamingResponse(events: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const e of events) controller.enqueue(enc.encode(e));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function drain(it: AsyncIterable<unknown>) {
  for await (const _ of it) { /* drain */ }
}

describe("T12: adapter factory wiring (regression)", () => {
  it("constructs an OpenAiCodexAdapter when provider=openai-codex", () => {
    const adapter = buildLlm({ provider: "openai-codex", model: "gpt-5.5" });
    expect(adapter).toBeInstanceOf(OpenAiCodexAdapter);
  });

  it("falls back to OpenAiAdapter for unknown providers (no codex bleed)", () => {
    const adapter = buildLlm({ provider: "ollama", model: "gpt-oss:20b", base_url: "http://localhost:11434/v1" });
    expect(adapter).toBeInstanceOf(OpenAiAdapter);
    expect(adapter).not.toBeInstanceOf(OpenAiCodexAdapter);
  });
});

describe("T12: Codex protocol invariants (live-smoke regressions)", () => {
  beforeEach(() => {
    vi.mocked(ensureFreshToken).mockReset();
    vi.mocked(ensureFreshToken).mockResolvedValue(FRESH_TOKENS);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hoists system messages into top-level `instructions` and sets `store: false`", async () => {
    // Smoke gotcha #2 + #3: Codex returns 400 if either is missing.
    const fetchMock = vi.fn(async () => streamingResponse([
      `data: ${JSON.stringify({ type: "response.completed", response: { finish_reason: "stop" } })}\n\n`,
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAiCodexAdapter({ version: "0.1.1" });
    const messages: ChatMessage[] = [
      { role: "system", content: "Be terse." },
      { role: "user", content: "ping" },
    ];
    await drain(adapter.complete(messages, [], { stream: true }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.instructions).toBe("Be terse.");
    expect(body.store).toBe(false);
    // System message is NOT in input[].
    expect(body.input.find((m: any) => m.role === "system")).toBeUndefined();
  });

  it("flattens tool definitions and sanitizes dotted tool names", async () => {
    // Smoke gotchas #4 (`Missing tools[0].name`) + #5 (`Invalid pattern`).
    const fetchMock = vi.fn(async () => streamingResponse([
      `data: ${JSON.stringify({ type: "response.completed", response: { finish_reason: "stop" } })}\n\n`,
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const tools: LlmTool[] = [
      {
        type: "function",
        function: {
          name: "media.stats",
          description: "Get media catalog totals",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
    ];
    const adapter = new OpenAiCodexAdapter({ version: "0.1.1" });
    await drain(adapter.complete([{ role: "user", content: "stats?" }], tools, { stream: true }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toHaveLength(1);
    // Flattened — name at the top level, NOT under `function`.
    expect(body.tools[0].type).toBe("function");
    expect(body.tools[0].name).toBe("media_stats");
    // Description and parameters round-trip.
    expect(body.tools[0].description).toBe("Get media catalog totals");
    expect(body.tools[0].parameters).toEqual({ type: "object", properties: {}, required: [] });
  });

  it("reshapes role:tool messages into `function_call_output` items with a non-empty call_id", async () => {
    // Smoke gotchas #7 (`Invalid value: 'tool'`) + #8
    // (`No tool call found for function call output with call_id ...`).
    const fetchMock = vi.fn(async () => streamingResponse([
      `data: ${JSON.stringify({ type: "response.completed", response: { finish_reason: "stop" } })}\n\n`,
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAiCodexAdapter({ version: "0.1.1" });
    const messages: ChatMessage[] = [
      { role: "user", content: "stats?" },
      // Assistant turn that emitted a tool call (no preamble text).
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc123",
            type: "function",
            function: { name: "media.stats", arguments: "{}" },
          },
        ],
      },
      // Tool result, paired by tool_call_id.
      {
        role: "tool",
        content: '{"total":10}',
        tool_call_id: "call_abc123",
        name: "media.stats",
      },
    ];
    await drain(adapter.complete(messages, [], { stream: true }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // No raw `role: "tool"` items leaked into input[].
    expect(body.input.find((m: any) => m.role === "tool")).toBeUndefined();

    // Empty assistant content is dropped (would otherwise trip
    // `"Invalid value: empty"` on some upstream paths).
    const emptyAssistant = body.input.find(
      (m: any) => m.role === "assistant" && (!m.content || m.content === ""),
    );
    expect(emptyAssistant).toBeUndefined();

    // function_call item carries sanitized name + matching call_id.
    const fc = body.input.find((m: any) => m.type === "function_call");
    expect(fc).toBeDefined();
    expect(fc.name).toBe("media_stats");
    expect(fc.call_id).toBe("call_abc123");
    expect(fc.arguments).toBe("{}");

    // function_call_output item is paired by call_id and carries the
    // serialized tool result.
    const fco = body.input.find((m: any) => m.type === "function_call_output");
    expect(fco).toBeDefined();
    expect(fco.call_id).toBe("call_abc123");
    expect(fco.output).toBe('{"total":10}');
  });

  it("substitutes a synthetic call_id when the upstream stripped it (defensive)", async () => {
    // Defense-in-depth: even if upstream code somewhere drops
    // tool_call_id, we should never send `""` to Codex
    // (smoke gotcha #8 reproduced as `empty_string` 400).
    const fetchMock = vi.fn(async () => streamingResponse([
      `data: ${JSON.stringify({ type: "response.completed", response: { finish_reason: "stop" } })}\n\n`,
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAiCodexAdapter({ version: "0.1.1" });
    const messages: ChatMessage[] = [
      { role: "user", content: "stats?" },
      {
        role: "tool",
        content: '{"total":10}',
        // tool_call_id intentionally omitted to simulate upstream bug
      },
    ];
    await drain(adapter.complete(messages, [], { stream: true }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const fco = body.input.find((m: any) => m.type === "function_call_output");
    expect(fco).toBeDefined();
    expect(fco.call_id).not.toBe("");
    expect(fco.call_id.length).toBeGreaterThan(4);
  });
});
