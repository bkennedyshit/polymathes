import { describe, it, expect } from "vitest";
import { runEpisode } from "../src/orchestrator/loop.js";
import { collectStream } from "../src/orchestrator/stream.js";
import { buildSystemPrompt } from "../src/orchestrator/context.js";
import { WorkingMemory } from "../src/memory/working.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { AgentRegistry } from "../src/agents/registry.js";
import { routeMessage } from "../src/agents/router.js";
import { spawnSubagent } from "../src/sessions/subagent.js";
import type { ChatMessage, ChatDelta, LlmAdapter, LlmTool, ToolCall } from "../src/llm/types.js";
import { z } from "zod";

// --- Helpers ---

function makeLlm(responses: ChatDelta[][]): LlmAdapter {
  let call = 0;
  return {
    async *complete() {
      const deltas = responses[call++] ?? [];
      for (const d of deltas) yield d;
    },
  };
}

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register({
    name: "core.final_answer",
    description: "Return final answer",
    parameters: z.object({ answer: z.string() }),
    handler: async (args: any) => args.answer,
  });
  return reg;
}

// Minimal router that bypasses policy/audit
function makeRouter(registry: ToolRegistry) {
  return {
    async invoke(name: string, args: unknown, _ctx: unknown) {
      const def = registry.get(name);
      if (!def) throw new Error(`tool not found: ${name}`);
      return def.handler(args, _ctx);
    },
  } as any;
}

function makeCtx(llm: LlmAdapter, registry?: ToolRegistry) {
  const reg = registry ?? makeRegistry();
  return {
    llm,
    router: makeRouter(reg),
    registry: reg,
    memory: new WorkingMemory(),
    maxIterations: 10,
    maxTokenBudget: 100_000,
    contextWindow: 50_000,
    sessionId: "test-session",
  };
}

// --- Tests ---

describe("buildSystemPrompt", () => {
  it("includes soul, tools, and rules", () => {
    const prompt = buildSystemPrompt({
      soul: "I am Polymath.",
      tools: [{ type: "function", function: { name: "search", description: "Search things", parameters: { type: "object" } } }],
      policyHints: ["Be safe"],
    });
    // Identity is always present.
    expect(prompt).toContain("Polymath");
    // Soul (skill / context) is appended.
    expect(prompt).toContain("I am Polymath.");
    // Policy hint is included.
    expect(prompt).toContain("Be safe");
    // Final-answer rule is mentioned.
    expect(prompt).toContain("core.final_answer");
    // Note: tool schemas are NOT dumped into the system prompt anymore —
    // they're delivered through the native `tools` API param instead. So
    // we deliberately do NOT assert the tool name appears in the prompt.
  });
});

describe("collectStream", () => {
  it("assembles content and tool calls", async () => {
    async function* gen(): AsyncIterable<ChatDelta> {
      yield { content: "Hello " };
      yield { content: "world" };
      yield { tool_calls: [{ id: "tc1", type: "function", function: { name: "foo", arguments: '{"a":1}' } }] };
      yield { usage: { prompt_tokens: 10, completion_tokens: 5 } };
    }
    const result = await collectStream(gen());
    expect(result.content).toBe("Hello world");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.function.name).toBe("foo");
    expect(result.tokensIn).toBe(10);
    expect(result.tokensOut).toBe(5);
  });
});

describe("runEpisode", () => {
  it("completes with final_answer tool call", async () => {
    const llm = makeLlm([
      // First response: call final_answer
      [
        {
          tool_calls: [{
            id: "tc1",
            type: "function",
            function: { name: "core.final_answer", arguments: '{"answer":"42"}' },
          }],
        },
        { usage: { prompt_tokens: 20, completion_tokens: 10 } },
      ],
    ]);

    const result = await runEpisode("What is the answer?", makeCtx(llm));
    expect(result.status).toBe("completed");
    expect(result.finalAnswer).toBe("42");
    expect(result.iterations).toBe(1);
  });

  it("completes when LLM returns no tool calls (plain text)", async () => {
    const llm = makeLlm([
      [{ content: "The answer is 42." }, { usage: { prompt_tokens: 10, completion_tokens: 5 } }],
    ]);

    const result = await runEpisode("What is the answer?", makeCtx(llm));
    expect(result.status).toBe("completed");
    expect(result.finalAnswer).toBe("The answer is 42.");
  });

  it("detects duplicate calls and injects corrective message", async () => {
    const reg = makeRegistry();
    reg.register({
      name: "search",
      description: "Search",
      parameters: z.object({ q: z.string() }),
      handler: async () => "result1",
    });

    let call = 0;
    const llm: LlmAdapter = {
      async *complete() {
        call++;
        if (call <= 2) {
          // Same tool call twice
          yield { tool_calls: [{ id: `tc${call}`, type: "function" as const, function: { name: "search", arguments: '{"q":"test"}' } }] };
          yield { usage: { prompt_tokens: 10, completion_tokens: 5 } };
        } else {
          yield { tool_calls: [{ id: "tc3", type: "function" as const, function: { name: "core.final_answer", arguments: '{"answer":"done"}' } }] };
          yield { usage: { prompt_tokens: 10, completion_tokens: 5 } };
        }
      },
    };

    const result = await runEpisode("test", makeCtx(llm, reg));
    expect(result.status).toBe("completed");
    expect(result.finalAnswer).toBe("done");
    // Should have taken 3 iterations (first call, duplicate detected, then final_answer)
    expect(result.iterations).toBe(3);
  });

  it("stops at max_iterations", async () => {
    const reg = makeRegistry();
    reg.register({
      name: "search",
      description: "Search",
      parameters: z.object({ q: z.string() }),
      handler: async () => "result",
    });

    let call = 0;
    const llm: LlmAdapter = {
      async *complete() {
        call++;
        yield { tool_calls: [{ id: `tc${call}`, type: "function" as const, function: { name: "search", arguments: `{"q":"q${call}"}` } }] };
        yield { usage: { prompt_tokens: 10, completion_tokens: 5 } };
      },
    };

    const ctx = makeCtx(llm, reg);
    ctx.maxIterations = 3;
    const result = await runEpisode("loop forever", ctx);
    expect(result.status).toBe("max_iterations");
    expect(result.iterations).toBe(3);
  });

  it("respects cancellation signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const llm = makeLlm([]);
    const ctx = makeCtx(llm);
    ctx.signal = controller.signal;

    const result = await runEpisode("test", ctx);
    expect(result.status).toBe("cancelled");
    expect(result.iterations).toBe(0);
  });

  it("stops when token budget exceeded", async () => {
    const llm = makeLlm([
      [{ content: "thinking..." }, { usage: { prompt_tokens: 50000, completion_tokens: 60000 } }],
    ]);

    const ctx = makeCtx(llm);
    ctx.maxTokenBudget = 100;

    const result = await runEpisode("test", ctx);
    expect(result.status).toBe("max_iterations");
  });
});

describe("AgentRegistry", () => {
  it("loads agents and returns default", () => {
    const reg = new AgentRegistry();
    reg.loadFromConfig([
      { id: "main", name: "Main", model: "gpt-4" },
      { id: "code", name: "Coder", model: "gpt-4", toolsets: ["code"] },
    ]);
    expect(reg.get("main")).toBeDefined();
    expect(reg.getDefault()?.id).toBe("main");
    expect(reg.get("code")?.toolsets).toEqual(["code"]);
  });
});

describe("routeMessage", () => {
  it("returns default agent", () => {
    const reg = new AgentRegistry();
    reg.loadFromConfig([{ id: "a1", name: "Agent1", model: "m" }]);
    const agent = routeMessage("cli", "user1", "hello", reg);
    expect(agent?.id).toBe("a1");
  });
});

describe("spawnSubagent", () => {
  it("runs a child episode", async () => {
    const llm = makeLlm([
      [
        { tool_calls: [{ id: "tc1", type: "function", function: { name: "core.final_answer", arguments: '{"answer":"child done"}' } }] },
        { usage: { prompt_tokens: 5, completion_tokens: 3 } },
      ],
    ]);

    const result = await spawnSubagent("sub task", {
      parentSessionId: "root",
      ctx: makeCtx(llm),
    });
    expect(result.status).toBe("completed");
    expect(result.finalAnswer).toBe("child done");
  });

  it("fails when depth limit exceeded", async () => {
    const llm = makeLlm([]);
    const result = await spawnSubagent("deep task", {
      parentSessionId: "root/a/b/c",
      ctx: makeCtx(llm),
    });
    expect(result.status).toBe("failed");
  });
});
