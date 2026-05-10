export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatDelta {
  content?: string;
  tool_calls?: Partial<ToolCall>[];
  finish_reason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface LlmTool {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export interface CompletionOptions {
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  signal?: AbortSignal;
}

export interface LlmAdapter {
  complete(messages: ChatMessage[], tools: LlmTool[], opts?: CompletionOptions): AsyncIterable<ChatDelta>;
}
