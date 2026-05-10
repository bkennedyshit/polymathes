import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { OpenAiAdapter } from "../src/llm/openai.js";
import { AnthropicAdapter } from "../src/llm/anthropic.js";
import { FailoverAdapter } from "../src/llm/failover.js";
import type { ChatMessage, LlmTool, ChatDelta } from "../src/llm/types.js";

async function collect(iter: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const results: ChatDelta[] = [];
  for await (const d of iter) results.push(d);
  return results;
}

// --- Mock server ---
let server: http.Server;
let port: number;
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeAll(async () => {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as any).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const msgs: ChatMessage[] = [{ role: "user", content: "hi" }];
const tools: LlmTool[] = [];

describe("OpenAiAdapter", () => {
  it("non-streaming response", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }));
    };

    const adapter = new OpenAiAdapter({ base_url: `http://127.0.0.1:${port}`, api_key: "k", model: "m" });
    const deltas = await collect(adapter.complete(msgs, tools));
    expect(deltas[0].content).toBe("hello");
    expect(deltas[0].finish_reason).toBe("stop");
    expect(deltas[1].usage).toEqual({ prompt_tokens: 5, completion_tokens: 3 });
  });

  it("streaming with tool calls", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunks = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "tc1", function: { name: "get_weather", arguments: '{"lo' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'c":"NY"}' } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ];
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    };

    const adapter = new OpenAiAdapter({ base_url: `http://127.0.0.1:${port}`, api_key: "k", model: "m", streaming: true });
    const deltas = await collect(adapter.complete(msgs, tools));
    const toolDelta = deltas.find((d) => d.tool_calls?.length);
    expect(toolDelta).toBeDefined();
    expect(toolDelta!.tool_calls![0]).toMatchObject({
      id: "tc1",
      type: "function",
      function: { name: "get_weather", arguments: '{"loc":"NY"}' },
    });
  });

  it("retries on 5xx", async () => {
    let attempts = 0;
    handler = (_req, res) => {
      attempts++;
      if (attempts < 3) {
        res.writeHead(500);
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
      }
    };

    const adapter = new OpenAiAdapter({ base_url: `http://127.0.0.1:${port}`, api_key: "k", model: "m" });
    const deltas = await collect(adapter.complete(msgs, tools));
    expect(deltas[0].content).toBe("ok");
    expect(attempts).toBe(3);
  });
});

describe("AnthropicAdapter", () => {
  it("non-streaming basic response", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        content: [{ type: "text", text: "bonjour" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
    };

    const adapter = new AnthropicAdapter({ base_url: `http://127.0.0.1:${port}`, api_key: "k", model: "m" });
    const deltas = await collect(adapter.complete(msgs, tools));
    expect(deltas[0].content).toBe("bonjour");
    expect(deltas[0].finish_reason).toBe("stop");
    expect(deltas[1].usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
  });
});

describe("FailoverAdapter", () => {
  it("switches to second adapter on error", async () => {
    // Use a failing adapter that throws immediately, then a working one
    const failing: import("../src/llm/types.js").LlmAdapter = {
      async *complete() { throw new Error("primary down"); },
    };

    let called = false;
    handler = (_req, res) => {
      called = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "fallback" }, finish_reason: "stop" }] }));
    };

    const a2 = new OpenAiAdapter({ base_url: `http://127.0.0.1:${port}`, api_key: "k", model: "m2" });
    const failover = new FailoverAdapter([failing, a2]);
    const deltas = await collect(failover.complete(msgs, tools));
    expect(deltas[0].content).toBe("fallback");
    expect(called).toBe(true);
  });
});
