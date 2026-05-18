import { ulid } from "ulid";
import type { ChatMessage, LlmAdapter, LlmTool } from "../llm/types.js";
import type { ToolRouter } from "../tools/router.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { WorkingMemory } from "../memory/working.js";
import { buildSystemPrompt } from "./context.js";
import { collectStream } from "./stream.js";
import { extractToolCalls } from "../llm/tool_call_extract.js";
import { sanitizeContext } from "../memory/scrubber.js";

export interface EpisodeEvent {
  type: "iteration_start" | "assistant_delta" | "tool_call" | "tool_result" | "final" | "error";
  iteration?: number;
  content?: string;
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  error?: string;
  answer?: string;
}

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
  /** Per-episode model override. Skills use this to swap to a specialist model. */
  modelOverride?: string;
  onIteration?: (i: number) => void;
  onEvent?: (ev: EpisodeEvent) => void;
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
    ctx.onEvent?.({ type: "iteration_start", iteration: iterations });

    // Truncate history to fit context window
    ctx.memory.clear();
    for (const m of history) {
      ctx.memory.add({
        role: m.role,
        content: m.content ?? "",
        // Preserve tool-calling fields end-to-end. Adapters that
        // require paired function_call + function_call_output items
        // (Codex Responses) break without them.
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.name ? { name: m.name } : {}),
      });
    }
    ctx.memory.truncate(ctx.contextWindow);

    const truncated: ChatMessage[] = ctx.memory.getAll().map((m) => ({
      role: m.role,
      content: m.content,
      // Preserve tool-calling fields so adapters that round-trip them
      // (Codex Responses, OpenAI Chat Completions with strict mode)
      // see a complete prior turn. Dropping these caused the Codex
      // adapter to emit `function_call_output` items without their
      // matching `function_call`, which trips a 400
      // `"No tool call found for function call output"`.
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {}),
    }));

    const stream = ctx.llm.complete(truncated, tools, { signal: ctx.signal, model: ctx.modelOverride });
    const result = await collectStream(stream);

    // Recover tool calls that some open-source models emit in `content` as
    // XML/JSON/fenced blocks rather than through the native tool_calls API.
    // (Hermes3, Qwen variants, Llama3 fine-tunes.) Without this step those
    // would leak to the user as literal JSON.
    if ((!result.toolCalls || result.toolCalls.length === 0) && result.content) {
      const extracted = extractToolCalls(result.content);
      if (extracted.extractedCalls.length > 0) {
        result.toolCalls = extracted.extractedCalls;
        result.content = extracted.cleanedContent;
      }
    }

    totalPrompt += result.tokensIn;
    totalCompletion += result.tokensOut;

    if (totalPrompt + totalCompletion > ctx.maxTokenBudget) {
      return { id, status: "max_iterations", finalAnswer: null, iterations, totalTokens: { prompt: totalPrompt, completion: totalCompletion } };
    }

    if (!result.toolCalls.length) {
      // No tool calls — treat content as final answer.
      // Defense-in-depth: strip leftover tool-call syntax if the model chose
      // to emit bare JSON on its last turn instead of calling core.final_answer.
      let answer = result.content ?? "";
      const residual = extractToolCalls(answer);
      if (residual.extractedCalls.length > 0 && !residual.cleanedContent) {
        // Entire message was tool-call syntax but we already hit no-tool-calls
        // branch. Convert to a user-friendly explanation.
        const names = residual.extractedCalls.map((tc) => tc.function.name).join(", ");
        answer = `(I tried to call ${names} but didn't receive the result. Please try again.)`;
      } else if (residual.cleanedContent) {
        answer = residual.cleanedContent;
      }
      // Strip any leaked <memory-context> blocks before delivery.
      answer = sanitizeContext(answer);
      ctx.onEvent?.({ type: "final", answer });
      return { id, status: "completed", finalAnswer: answer || null, iterations, totalTokens: { prompt: totalPrompt, completion: totalCompletion } };
    }

    // Add assistant message with tool calls
    history.push({ role: "assistant", content: result.content || null, tool_calls: result.toolCalls });
    if (result.content) ctx.onEvent?.({ type: "assistant_delta", content: result.content });

    // Detect models that get stuck calling `core.think` as their "answer".
    // If every tool call this turn is core.think with no real work, satisfy
    // the tool-result protocol and nudge the model toward core.final_answer.
    const onlyThinking = result.toolCalls.every((tc) => tc.function.name === "core.think");
    if (onlyThinking && iterations >= 2) {
      // Emit proper tool responses for each think call so history stays valid.
      for (const tc of result.toolCalls) {
        history.push({
          role: "tool",
          content: "ok (logged, user did not see this)",
          tool_call_id: tc.id,
        });
      }
      // Then a system-level nudge.
      history.push({
        role: "tool",
        content:
          "STOP — you've been calling core.think repeatedly. The user has NOT seen any of it. " +
          "On the next turn you MUST call core.final_answer with a plain-text reply, OR call " +
          "a real tool like files.read / web.search / skill.X. Do not call core.think again.",
        tool_call_id: result.toolCalls[result.toolCalls.length - 1]!.id,
      });
      continue;
    }

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
        // Strip any leaked <memory-context> tags before delivery.
        answer = sanitizeContext(answer);
        ctx.onEvent?.({ type: "final", answer });
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
      ctx.onEvent?.({ type: "tool_call", toolName: tc.function.name, toolArgs: tc.function.arguments });
      let toolResult: string;
      try {
        const raw = await ctx.router.invoke(tc.function.name, JSON.parse(tc.function.arguments), { sessionId: ctx.sessionId });
        toolResult = typeof raw === "string" ? raw : JSON.stringify(raw);
      } catch (e: any) {
        toolResult = `Error: ${e.message}`;
        ctx.onEvent?.({ type: "error", error: e.message, toolName: tc.function.name });
      }
      ctx.onEvent?.({ type: "tool_result", toolName: tc.function.name, toolResult });

      history.push({ role: "tool", content: toolResult, tool_call_id: tc.id });
    }
  }

  return { id, status: "max_iterations", finalAnswer: null, iterations, totalTokens: { prompt: totalPrompt, completion: totalCompletion } };
}
