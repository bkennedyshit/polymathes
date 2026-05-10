import type { ChatDelta, ToolCall } from "../llm/types.js";

export interface StreamResult {
  content: string;
  toolCalls: ToolCall[];
  tokensIn: number;
  tokensOut: number;
}

export async function collectStream(stream: AsyncIterable<ChatDelta>): Promise<StreamResult> {
  let content = "";
  const callMap = new Map<number, { id: string; name: string; args: string }>();
  let tokensIn = 0;
  let tokensOut = 0;

  for await (const delta of stream) {
    if (delta.content) content += delta.content;

    if (delta.tool_calls) {
      for (let i = 0; i < delta.tool_calls.length; i++) {
        const tc = delta.tool_calls[i]!;
        const idx = i;
        const existing = callMap.get(idx);
        if (!existing) {
          callMap.set(idx, {
            id: tc.id ?? "",
            name: tc.function?.name ?? "",
            args: tc.function?.arguments ?? "",
          });
        } else {
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.args += tc.function.arguments;
        }
      }
    }

    if (delta.usage) {
      tokensIn = delta.usage.prompt_tokens;
      tokensOut = delta.usage.completion_tokens;
    }
  }

  const toolCalls: ToolCall[] = [...callMap.values()].map((c) => ({
    id: c.id,
    type: "function" as const,
    function: { name: c.name, arguments: c.args },
  }));

  return { content, toolCalls, tokensIn, tokensOut };
}
