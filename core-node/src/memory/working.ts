import type { ToolCall } from "../llm/types.js";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /**
   * Tool calls emitted by an assistant turn. Adapters that demand
   * paired `function_call` + `function_call_output` items (Codex
   * Responses, OpenAI Chat Completions strict) reject conversations
   * where these are missing on the prior turn.
   */
  tool_calls?: ToolCall[];
  /**
   * Set on `role: "tool"` messages to bind the result back to the
   * call_id the model emitted. Required by every Responses-style API.
   */
  tool_call_id?: string;
  /** Optional name on tool-result messages (some adapters surface it). */
  name?: string;
}

export class WorkingMemory {
  private buffer: Message[] = [];

  add(message: Message): void {
    this.buffer.push(message);
  }

  getAll(): Message[] {
    return [...this.buffer];
  }

  getRecent(n: number): Message[] {
    return this.buffer.slice(-n);
  }

  clear(): void {
    this.buffer = [];
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  truncate(maxTokens: number): void {
    let total = this.buffer.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
    if (total <= maxTokens) return;

    const system = this.buffer.filter((m) => m.role === "system");
    const nonSystem = this.buffer.filter((m) => m.role !== "system");

    const systemTokens = system.reduce((s, m) => s + this.estimateTokens(m.content), 0);
    const budget = maxTokens - systemTokens;

    const kept: Message[] = [];
    let used = 0;
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      const t = this.estimateTokens(nonSystem[i]!.content);
      if (used + t > budget) break;
      kept.unshift(nonSystem[i]!);
      used += t;
    }

    const dropped = nonSystem.length - kept.length;
    this.buffer = [
      ...system,
      ...(dropped > 0
        ? [{ role: "system" as const, content: `[${dropped} earlier messages omitted]` }]
        : []),
      ...kept,
    ];
  }
}
