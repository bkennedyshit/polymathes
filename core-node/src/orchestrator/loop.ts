import { ulid } from "ulid";
import type { ChatMessage, LlmAdapter, LlmTool } from "../llm/types.js";
import type { ToolRouter } from "../tools/router.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { WorkingMemory } from "../memory/working.js";
import { buildSystemPrompt } from "./context.js";
import { collectStream } from "./stream.js";

export interface EpisodeContext {
  llm: LlmAdapter;
  router: ToolRouter;
  registry: ToolRegistry;
  memory: WorkingMemory;
  maxIterations: number;
  maxTokenBudget: number;
  contextWindow: number;
  signal?: AbortSignal;
  sessionId: string;
  soul?: string;
  policyHints?: string[];
  onIteration?: (i: number) => void;
}

export interface EpisodeResult {
  id: string;
  status: "completed" | "failed" | "cancelled" | "max_iterations";
  finalAnswer: string | null;
  iterations: number;
  totalTokens: { prompt: number; completion: number };
}

export async function runEpisode(task: string, ctx: EpisodeContext): Promise<EpisodeResult> {
  const id = ulid();
  const tools: LlmTool[] = ctx.registry.schemas();
  const systemPrompt = buildSystemPrompt({ soul: ctx.soul, tools, policyHints: ctx.policyHints });

  const history: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task },
  ];

  let iterations = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;
  let lastCallKey = "";

  while (iterations < ctx.maxIterations) {
    if (ctx.signal?.aborted) {
      return { id, status: "cancelled", finalAnswer: null, iterations, totalTokens: { prompt: totalPrompt, completion: totalCompletion } };
    }

    iterations++;
    ctx.onIteration?.(iterations);

    // Truncate history to fit context window
    ctx.memory.clear();
    for (const m of history) ctx.memory.add({ role: m.role, content: m.content ?? "" });
    ctx.memory.truncate(ctx.contextWindow);

    const truncated: ChatMessage[] = ctx.memory.getAll().map((m) => ({ role: m.role, content: m.content }));

    const stream = ctx.llm.complete(truncated, tools, { signal: ctx.signal });
    const result = await collectStream(stream);

    totalPrompt += result.tokensIn;
    totalCompletion += result.tokensOut;

    if (totalPrompt + totalCompletion > ctx.maxTokenBudget) {
      return { id, status: "max_iterations", finalAnswer: null, iterations, totalTokens: { prompt: totalPrompt, completion: totalCompletion } };
    }

    if (!result.toolCalls.length) {
      // No tool calls — treat content as final answer
      return { id, status: "completed", finalAnswer: result.content || null, iterations, totalTokens: { prompt: totalPrompt, completion: totalCompletion } };
    }

    // Add assistant message with tool calls
    history.push({ role: "assistant", content: result.content || null, tool_calls: result.toolCalls });

    for (const tc of result.toolCalls) {
      // Handle final_answer specially
      if (tc.function.name === "core.final_answer") {
        let answer: string;
        try {
          const parsed = JSON.parse(tc.function.arguments);
          answer = parsed.answer ?? parsed.text ?? tc.function.arguments;
        } catch {
          answer = tc.function.arguments;
        }
        return { id, status: "completed", finalAnswer: answer, iterations, totalTokens: { prompt: totalPrompt, completion: totalCompletion } };
      }

      // Duplicate detection
      const callKey = `${tc.function.name}:${tc.function.arguments}`;
      if (callKey === lastCallKey) {
        history.push({ role: "tool", content: "Error: duplicate call. Use a different approach or call core.final_answer.", tool_call_id: tc.id });
        continue;
      }
      lastCallKey = callKey;

      // Invoke tool
      let toolResult: string;
      try {
        const raw = await ctx.router.invoke(tc.function.name, JSON.parse(tc.function.arguments), { sessionId: ctx.sessionId });
        toolResult = typeof raw === "string" ? raw : JSON.stringify(raw);
      } catch (e: any) {
        toolResult = `Error: ${e.message}`;
      }

      history.push({ role: "tool", content: toolResult, tool_call_id: tc.id });
    }
  }

  return { id, status: "max_iterations", finalAnswer: null, iterations, totalTokens: { prompt: totalPrompt, completion: totalCompletion } };
}
