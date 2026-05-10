import type { LlmAdapter, ChatMessage, ChatDelta, LlmTool, CompletionOptions } from "./types.js";

export interface AnthropicConfig {
  base_url: string;
  api_key: string;
  model: string;
  streaming?: boolean;
}

export class AnthropicAdapter implements LlmAdapter {
  constructor(private cfg: AnthropicConfig) {}

  async *complete(messages: ChatMessage[], tools: LlmTool[], opts?: CompletionOptions): AsyncIterable<ChatDelta> {
    const stream = opts?.stream ?? this.cfg.streaming ?? false;
    const { system, converted } = this.convertMessages(messages);

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: converted,
      max_tokens: opts?.max_tokens ?? 4096,
      stream,
    };
    if (system) body.system = system;
    if (tools.length) body.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
    if (opts?.temperature != null) body.temperature = opts.temperature;

    const res = await fetch(`${this.cfg.base_url}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.cfg.api_key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: opts?.signal,
    });

    if (!res.ok) throw new Error(`Anthropic error: HTTP ${res.status}`);

    if (stream) {
      yield* this.parseSSE(res);
    } else {
      const json = await res.json() as any;
      yield* this.parseResponse(json);
    }
  }

  private *parseResponse(json: any): Iterable<ChatDelta> {
    const toolCalls: ChatDelta["tool_calls"] = [];
    let text = "";
    for (const block of json.content ?? []) {
      if (block.type === "text") text += block.text;
      if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input) } });
      }
    }
    if (toolCalls.length) yield { tool_calls: toolCalls, finish_reason: "tool_calls" };
    else yield { content: text, finish_reason: json.stop_reason === "end_turn" ? "stop" : json.stop_reason };
    if (json.usage) yield { usage: { prompt_tokens: json.usage.input_tokens, completion_tokens: json.usage.output_tokens } };
  }

  private async *parseSSE(response: Response): AsyncIterable<ChatDelta> {
    const reader = response.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const toolCalls: { id: string; name: string; args: string }[] = [];
    let currentToolIdx = -1;

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
          const event = JSON.parse(data);
          if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
            currentToolIdx++;
            toolCalls.push({ id: event.content_block.id, name: event.content_block.name, args: "" });
          } else if (event.type === "content_block_delta") {
            if (event.delta?.type === "text_delta" && event.delta.text) {
              yield { content: event.delta.text };
            } else if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
              if (currentToolIdx >= 0) toolCalls[currentToolIdx].args += event.delta.partial_json;
            }
          } else if (event.type === "message_delta") {
            if (event.usage) yield { usage: { prompt_tokens: 0, completion_tokens: event.usage.output_tokens } };
          } else if (event.type === "message_stop") {
            if (toolCalls.length) {
              yield {
                tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.args } })),
                finish_reason: "tool_calls",
              };
            } else {
              yield { finish_reason: "stop" };
            }
          }
        } catch { /* skip */ }
      }
    }
  }

  private convertMessages(messages: ChatMessage[]): { system: string | undefined; converted: unknown[] } {
    let system: string | undefined;
    const converted: unknown[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        system = (system ? system + "\n" : "") + (msg.content ?? "");
        continue;
      }
      if (msg.role === "assistant") {
        const content: unknown[] = [];
        if (msg.content) content.push({ type: "text", text: msg.content });
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments) });
          }
        }
        converted.push({ role: "assistant", content });
      } else if (msg.role === "tool") {
        converted.push({ role: "user", content: [{ type: "tool_result", tool_use_id: msg.tool_call_id, content: msg.content ?? "" }] });
      } else {
        converted.push({ role: "user", content: msg.content ?? "" });
      }
    }
    return { system, converted };
  }
}
