import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the auth_refresh module the same way `tests/codex_auth_refresh.test.ts`
// mocks the auth_store. This isolates the adapter from disk + real refresh
// HTTP and lets us assert when each refresh helper is called.
vi.mock("../src/llm/codex/auth_refresh.js", () => ({
  ensureFreshToken: vi.fn(),
  forceRefresh: vi.fn(),
}));

import { OpenAiCodexAdapter } from "../src/llm/codex/responses_adapter.js";
import {
  ensureFreshToken,
  forceRefresh,
} from "../src/llm/codex/auth_refresh.js";
import { CodexAuthExpired } from "../src/llm/codex/responses_protocol.js";
import type {
  ChatDelta,
  ChatMessage,
  LlmTool,
} from "../src/llm/types.js";

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

const FRESH_TOKENS = {
  access_token: "access-fresh",
  id_token: "id-fresh",
  refresh_token: "refresh-fresh",
  account_id: "acct_test",
};

const REFRESHED_TOKENS = {
  access_token: "access-refreshed",
  id_token: "id-refreshed",
  refresh_token: "refresh-refreshed",
  account_id: "acct_test",
};

/**
 * Build a `Response` whose body streams the given SSE event strings in
 * order then closes. Events are written verbatim — callers are
 * responsible for the trailing `\n\n` framing.
 */
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

function jsonResponseObj(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function collect(iter: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = [];
  for await (const d of iter) out.push(d);
  return out;
}

const MSGS: ChatMessage[] = [{ role: "user", content: "hi" }];
const TOOLS: LlmTool[] = [];

describe("OpenAiCodexAdapter", () => {
  beforeEach(() => {
    vi.mocked(ensureFreshToken).mockReset();
    vi.mocked(forceRefresh).mockReset();
    vi.mocked(ensureFreshToken).mockResolvedValue(FRESH_TOKENS);
    vi.mocked(forceRefresh).mockResolvedValue(REFRESHED_TOKENS);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("Cassette 1: streams a simple text response and emits content + usage deltas", async () => {
    const events = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: " world" })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        },
      })}\n\n`,
    ];
    const fetchMock = vi.fn().mockResolvedValue(streamingResponse(events));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAiCodexAdapter({ version: "0.1.1" });
    const deltas = await collect(adapter.complete(MSGS, TOOLS, { stream: true }));

    expect(deltas).toEqual([
      { content: "hello" },
      { content: " world" },
      { finish_reason: "stop" },
      { usage: { prompt_tokens: 10, completion_tokens: 2 } },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(forceRefresh).not.toHaveBeenCalled();
  });

  it("Cassette 2: assembles tool-call deltas across SSE frames and emits them on completion", async () => {
    // Codex emits function calls through three event types:
    //   - response.output_item.added (with item.type="function_call")
    //   - response.function_call_arguments.delta (streamed args)
    //   - response.output_item.done (final state with full arguments)
    //
    // Verified live against `chatgpt.com/backend-api/codex/responses`.
    // The `response.tool_calls.delta` shape modeled before T5 was wrong.
    const events = [
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "fc_abc123",
          type: "function_call",
          name: "get_weather",
          call_id: "call_1",
          status: "in_progress",
          arguments: "",
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: "fc_abc123",
        output_index: 0,
        delta: '{"loc',
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: "fc_abc123",
        output_index: 0,
        delta: '":"NYC"}',
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.done",
        item_id: "fc_abc123",
        output_index: 0,
        arguments: '{"loc":"NYC"}',
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "fc_abc123",
          type: "function_call",
          name: "get_weather",
          call_id: "call_1",
          status: "completed",
          arguments: '{"loc":"NYC"}',
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          usage: { input_tokens: 8, output_tokens: 12, total_tokens: 20 },
        },
      })}\n\n`,
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamingResponse(events)));

    const adapter = new OpenAiCodexAdapter({ version: "0.1.1", streaming: true });
    const deltas = await collect(adapter.complete(MSGS, TOOLS));

    const toolDelta = deltas.find((d) => d.tool_calls?.length);
    expect(toolDelta).toBeDefined();
    expect(toolDelta!.finish_reason).toBe("tool_calls");
    expect(toolDelta!.tool_calls![0]).toMatchObject({
      id: "call_1",
      type: "function",
      function: { name: "get_weather", arguments: '{"loc":"NYC"}' },
    });

    const usageDelta = deltas.find((d) => d.usage);
    expect(usageDelta!.usage).toEqual({ prompt_tokens: 8, completion_tokens: 12 });
  });

  it("Cassette 3: refreshes tokens on 401, retries with the new access_token, and succeeds", async () => {
    const successEvents = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      })}\n\n`,
    ];

    const fetchMock = vi
      .fn()
      // First call: 401 — adapter must call forceRefresh().
      .mockResolvedValueOnce(jsonResponseObj(401, { error: "expired" }))
      // Second call: stream the success cassette.
      .mockResolvedValueOnce(streamingResponse(successEvents));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAiCodexAdapter({ version: "0.1.1" });
    const deltas = await collect(adapter.complete(MSGS, TOOLS, { stream: true }));

    expect(forceRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // First call used the fresh token, second call used the refreshed one.
    const firstHeaders = fetchMock.mock.calls[0][1].headers;
    const secondHeaders = fetchMock.mock.calls[1][1].headers;
    expect(firstHeaders.Authorization).toBe(`Bearer ${FRESH_TOKENS.access_token}`);
    expect(secondHeaders.Authorization).toBe(`Bearer ${REFRESHED_TOKENS.access_token}`);

    expect(deltas.find((d) => d.content)?.content).toBe("ok");
  });

  it("Cassette 4: throws CodexAuthExpired when the retry after refresh also returns 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponseObj(401, { error: "expired" }))
      .mockResolvedValueOnce(jsonResponseObj(401, { error: "still expired" }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAiCodexAdapter({ version: "0.1.1" });
    await expect(
      collect(adapter.complete(MSGS, TOOLS, { stream: true })),
    ).rejects.toBeInstanceOf(CodexAuthExpired);

    expect(forceRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Cassette 5: respects retry-after on 429 and retries", async () => {
    vi.useFakeTimers();
    const successEvents = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "later" })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      })}\n\n`,
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "1" },
        }),
      )
      .mockResolvedValueOnce(streamingResponse(successEvents));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAiCodexAdapter({ version: "0.1.1" });
    const promise = collect(adapter.complete(MSGS, TOOLS, { stream: true }));

    // Advance past the retry-after window so the adapter's `sleep` resolves.
    await vi.advanceTimersByTimeAsync(1100);
    const deltas = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(deltas.find((d) => d.content)?.content).toBe("later");
  });

  it("Cassette 6: throws when the stream emits a response.error event", async () => {
    const events = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.error",
        error: { message: "model overloaded", code: "overloaded" },
      })}\n\n`,
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamingResponse(events)));

    const adapter = new OpenAiCodexAdapter({ version: "0.1.1" });
    await expect(
      collect(adapter.complete(MSGS, TOOLS, { stream: true })),
    ).rejects.toThrow(/model overloaded/);
  });

  it("sends Authorization, OpenAI-Account-Id, and User-Agent headers on every request", async () => {
    const events = [
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } },
      })}\n\n`,
    ];
    const fetchMock = vi.fn().mockResolvedValue(streamingResponse(events));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAiCodexAdapter({ version: "0.9.9" });
    await collect(adapter.complete(MSGS, TOOLS, { stream: true }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(RESPONSES_URL);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${FRESH_TOKENS.access_token}`);
    expect(init.headers["OpenAI-Account-Id"]).toBe(FRESH_TOKENS.account_id);
    expect(init.headers["User-Agent"]).toBe("Polymath/0.9.9");
    expect(init.headers["Content-Type"]).toBe("application/json");
    // Streaming requests advertise the SSE accept type.
    expect(init.headers.Accept).toBe("text/event-stream");

    const body = JSON.parse(init.body);
    expect(body.stream).toBe(true);
    expect(body.input).toEqual([{ role: "user", content: "hi" }]);
    expect(body.model).toBe("gpt-5.5");
  });

  it("uses the per-call model override when provided", async () => {
    const events = [
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } },
      })}\n\n`,
    ];
    const fetchMock = vi.fn().mockResolvedValue(streamingResponse(events));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAiCodexAdapter({ version: "0.1.1", model: "gpt-5.3-codex" });
    await collect(adapter.complete(MSGS, TOOLS, { stream: true, model: "gpt-5.5-pro" }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-5.5-pro");
  });

  it("non-streaming path yields content + usage in two deltas", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponseObj(200, {
        output_text: "hello there",
        finish_reason: "stop",
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAiCodexAdapter({ version: "0.1.1" });
    const deltas = await collect(adapter.complete(MSGS, TOOLS, { stream: false }));

    expect(deltas).toEqual([
      { content: "hello there", finish_reason: "stop" },
      { usage: { prompt_tokens: 5, completion_tokens: 3 } },
    ]);
    // Non-streaming requests don't ask for SSE.
    expect(fetchMock.mock.calls[0][1].headers.Accept).toBeUndefined();
  });

  it("getAccountId returns null before any call and the cached account_id afterwards", async () => {
    const events = [
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } },
      })}\n\n`,
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamingResponse(events)));

    const adapter = new OpenAiCodexAdapter({ version: "0.1.1" });
    expect(adapter.getAccountId()).toBeNull();

    await collect(adapter.complete(MSGS, TOOLS, { stream: true }));
    expect(adapter.getAccountId()).toBe(FRESH_TOKENS.account_id);
  });

  it("maps assistant tool-call messages and tool-result messages into the input array", async () => {
    const events = [
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } },
      })}\n\n`,
    ];
    const fetchMock = vi.fn().mockResolvedValue(streamingResponse(events));
    vi.stubGlobal("fetch", fetchMock);

    const messages: ChatMessage[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"loc":"NYC"}' },
          },
        ],
      },
      {
        role: "tool",
        content: "sunny",
        tool_call_id: "call_1",
        name: "get_weather",
      },
    ];
    const adapter = new OpenAiCodexAdapter({ version: "0.1.1" });
    await collect(adapter.complete(messages, TOOLS, { stream: true }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // System message is hoisted into top-level `instructions` (the
    // Codex Responses API rejects requests without it with HTTP 400
    // `"Instructions are required"`).
    expect(body.instructions).toBe("you are helpful");
    // User message is now first in input[]; system is excluded.
    expect(body.input[0]).toEqual({ role: "user", content: "weather?" });    // Assistant tool-call message is split into typed items rather
    // than a single role:assistant blob with embedded JSON. Codex
    // Responses requires `function_call` + `function_call_output` pairs
    // (smoke gotcha #7 — it rejects `role: "tool"` outright).
    const fc = body.input.find((m: any) => m.type === "function_call");
    expect(fc).toBeDefined();
    expect(fc.name).toBe("get_weather");
    expect(fc.call_id).toBe("call_1");
    expect(fc.arguments).toBe('{"loc":"NYC"}');
    // Tool-result reshapes to function_call_output, not role:tool.
    const fco = body.input.find((m: any) => m.type === "function_call_output");
    expect(fco).toBeDefined();
    expect(fco.call_id).toBe("call_1");
    expect(fco.output).toBe("sunny");
  });

  it("hoists multiple system messages into a single concatenated `instructions` field", async () => {
    vi.mocked(ensureFreshToken).mockResolvedValue(FRESH_TOKENS);
    const fetchMock = vi.fn(async () => streamingResponse([
      `data: ${JSON.stringify({ type: "response.completed", response: { finish_reason: "stop" } })}\n\n`,
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const messages: ChatMessage[] = [
      { role: "system", content: "Persona: pragmatic." },
      { role: "system", content: "Always reply in plain text." },
      { role: "user", content: "hi" },
    ];
    const adapter = new OpenAiCodexAdapter({ version: "0.1.1" });
    await collect(adapter.complete(messages, TOOLS, { stream: true }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.instructions).toBe("Persona: pragmatic.\n\nAlways reply in plain text.");
    expect(body.input).toHaveLength(1);
    expect(body.input[0]).toEqual({ role: "user", content: "hi" });
  });

  it("supplies a default `instructions` string when no system message is present", async () => {
    vi.mocked(ensureFreshToken).mockResolvedValue(FRESH_TOKENS);
    const fetchMock = vi.fn(async () => streamingResponse([
      `data: ${JSON.stringify({ type: "response.completed", response: { finish_reason: "stop" } })}\n\n`,
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAiCodexAdapter({ version: "0.1.1" });
    await collect(adapter.complete(MSGS, TOOLS, { stream: true }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(typeof body.instructions).toBe("string");
    expect(body.instructions.length).toBeGreaterThan(0);
  });
});
