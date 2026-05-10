import type { LlmAdapter, ChatMessage, ChatDelta, LlmTool, CompletionOptions } from "./types.js";

export interface OpenAiConfig {
  base_url: string;
  api_key: string;
  model: string;
  streaming?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class OpenAiAdapter implements LlmAdapter {
  constructor(private cfg: OpenAiConfig) {}

  async *complete(messages: ChatMessage[], tools: LlmTool[], opts?: CompletionOptions): AsyncIterable<ChatDelta> {
    const stream = opts?.stream ?? this.cfg.streaming ?? false;
    const body: Record<string, unknown> = { model: this.cfg.model, messages, stream };
    if (tools.length) body.tools = tools;
    if (opts?.temperature != null) body.temperature = opts.temperature;
    if (opts?.max_tokens != null) body.max_tokens = opts.max_tokens;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.cfg.api_key}`,
    };

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${this.cfg.base_url}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: opts?.signal,
      });

      if (res.status === 429) {
        await res.body?.cancel();
        const retryAfter = Number(res.headers.get("retry-after") ?? "5") * 1000;
        await sleep(retryAfter);
        continue;
      }
      if (res.status >= 500) {
        await res.body?.cancel();
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`LLM error: HTTP ${res.status}`);

      if (stream) {
        yield* this.parseSSE(res);
      } else {
        const json = await res.json() as any;
        const choice = json.choices?.[0];
        const msg = choice?.message;
        if (msg?.tool_calls) yield { tool_calls: msg.tool_calls, finish_reason: "tool_calls" };
        else yield { content: msg?.content ?? "", finish_reason: choice?.finish_reason };
        if (json.usage) yield { usage: json.usage };
      }
      return;
    }
    throw lastErr ?? new Error("LLM request failed after retries");
  }

  private async *parseSSE(response: Response): AsyncIterable<ChatDelta> {
    const reader = response.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const toolCallBufs: Record<number, { id: string; name: string; args: string }> = {};

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          const assembled = Object.values(toolCallBufs).map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.args },
          }));
          if (assembled.length > 0) yield { tool_calls: assembled, finish_reason: "tool_calls" };
          return;
        }
        try {
          const chunk = JSON.parse(data);
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          const out: ChatDelta = {};
          if (choice.finish_reason) out.finish_reason = choice.finish_reason;
          if (delta.content) out.content = delta.content;
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx: number = tc.index ?? 0;
              if (!toolCallBufs[idx]) toolCallBufs[idx] = { id: "", name: "", args: "" };
              if (tc.id) toolCallBufs[idx].id = tc.id;
              if (tc.function?.name) toolCallBufs[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCallBufs[idx].args += tc.function.arguments;
            }
          }
          if (chunk.usage) out.usage = chunk.usage;
          if (out.content || out.finish_reason || out.usage) yield out;
        } catch { /* skip malformed */ }
      }
    }
    // If stream ended without [DONE], still emit assembled tool calls
    const assembled = Object.values(toolCallBufs).map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.args },
    }));
    if (assembled.length > 0) yield { tool_calls: assembled, finish_reason: "tool_calls" };
  }
}
