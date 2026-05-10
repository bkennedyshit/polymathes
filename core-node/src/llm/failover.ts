import type { LlmAdapter, ChatMessage, ChatDelta, LlmTool, CompletionOptions } from "./types.js";

export class FailoverAdapter implements LlmAdapter {
  constructor(private adapters: LlmAdapter[]) {
    if (!adapters.length) throw new Error("FailoverAdapter requires at least one adapter");
  }

  async *complete(messages: ChatMessage[], tools: LlmTool[], opts?: CompletionOptions): AsyncIterable<ChatDelta> {
    let lastErr: Error | null = null;
    for (const adapter of this.adapters) {
      try {
        yield* adapter.complete(messages, tools, opts);
        return;
      } catch (err) {
        lastErr = err as Error;
      }
    }
    throw lastErr ?? new Error("All adapters failed");
  }
}
