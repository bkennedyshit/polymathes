import type { LlmAdapter, ChatMessage, ChatDelta, LlmTool, CompletionOptions, ToolCall } from "./types.js";

export interface GoogleConfig {
  api_key: string;
  model: string;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export class GoogleAdapter implements LlmAdapter {
  constructor(private cfg: GoogleConfig) {}

  async *complete(messages: ChatMessage[], tools: LlmTool[], opts?: CompletionOptions): AsyncIterable<ChatDelta> {
    const { systemInstruction, contents } = this.convertMessages(messages);
    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.system_instruction = { parts: [{ text: systemInstruction }] };
    if (tools.length) {
      body.tools = [{ function_declarations: tools.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })) }];
    }
    if (opts?.temperature != null) body.generationConfig = { temperature: opts.temperature, maxOutputTokens: opts?.max_tokens ?? 4096 };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.cfg.model}:streamGenerateContent?alt=sse&key=${this.cfg.api_key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: opts?.signal,
    });

    if (!res.ok) throw new Error(`Google LLM error: HTTP ${res.status}`);

    yield* this.parseSSE(res);
  }

  private async *parseSSE(response: Response): AsyncIterable<ChatDelta> {
    const reader = response.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const toolCalls: ToolCall[] = [];
    let tcIdx = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data) continue;
        try {
          const chunk = JSON.parse(data);
          const candidate = chunk.candidates?.[0];
          if (!candidate?.content?.parts) continue;
          for (const part of candidate.content.parts) {
            if (part.text) yield { content: part.text };
            if (part.functionCall) {
              toolCalls.push({
                id: `call_${tcIdx++}`,
                type: "function",
                function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
              });
            }
          }
          if (candidate.finishReason === "STOP" && !toolCalls.length) yield { finish_reason: "stop" };
          if (chunk.usageMetadata) {
            yield { usage: { prompt_tokens: chunk.usageMetadata.promptTokenCount ?? 0, completion_tokens: chunk.usageMetadata.candidatesTokenCount ?? 0 } };
          }
        } catch { /* skip malformed */ }
      }
    }
    if (toolCalls.length) yield { tool_calls: toolCalls, finish_reason: "tool_calls" };
  }

  private convertMessages(messages: ChatMessage[]): { systemInstruction: string | undefined; contents: GeminiContent[] } {
    let systemInstruction: string | undefined;
    const contents: GeminiContent[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemInstruction = (systemInstruction ? systemInstruction + "\n" : "") + (msg.content ?? "");
      } else if (msg.role === "user") {
        contents.push({ role: "user", parts: [{ text: msg.content ?? "" }] });
      } else if (msg.role === "assistant") {
        const parts: GeminiPart[] = [];
        if (msg.content) parts.push({ text: msg.content });
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            parts.push({ functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments) } });
          }
        }
        if (parts.length) contents.push({ role: "model", parts });
      } else if (msg.role === "tool") {
        contents.push({ role: "user", parts: [{ functionResponse: { name: msg.name ?? "", response: JSON.parse(msg.content ?? "{}") } }] });
      }
    }
    return { systemInstruction, contents };
  }
}
