/**
 * Codex Responses API — type definitions.
 *
 * The Codex backend lives at `https://chatgpt.com/backend-api/codex` and
 * speaks a request/response shape adjacent to (but not identical to)
 * OpenAI's public Responses API. We model only the fields Polymath
 * actually round-trips.
 *
 * Token storage shape and the `CodexAuthExpired` error live here too so
 * the auth subsystem and the eventual adapter share a single import.
 */

/** Tokens persisted to `~/.polymath/codex-auth.json`. */
export interface CodexTokens {
  access_token: string;
  id_token: string;
  refresh_token: string;
  account_id: string;
}

/** Full on-disk shape of `codex-auth.json` (file mode 0600). */
export interface CodexAuthStored {
  auth_mode: "chatgpt";
  tokens: CodexTokens;
  /** ISO-8601 timestamp of the last successful token refresh. */
  last_refresh: string;
}

/**
 * Thrown when the refresh_token has been revoked or has expired and the
 * adapter cannot recover without a new login. Gateway maps this to a UI
 * banner; CLI maps this to a "re-run polymath llm login" hint.
 */
export class CodexAuthExpired extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CodexAuthExpired";
  }
}

/**
 * Codex Responses API request body. Mirrors the shape Codex CLI / IDE
 * plugins POST to `/backend-api/codex/responses`. We model only the
 * fields Polymath actually populates — the upstream accepts more, but
 * adding them speculatively just creates breakage when OpenAI rotates
 * the schema. `temperature` / `max_tokens` are intentionally omitted:
 * the reference clients don't send them and we have no evidence the
 * subscription endpoint honours them.
 */
export interface CodexResponsesRequest {
  model: string;
  /**
   * System prompt — the Codex Responses API rejects requests with
   * `{"detail":"Instructions are required"}` if this is missing.
   * Polymath builds it by concatenating all `system` role messages
   * in `extractInstructions()` before populating `input`.
   */
  instructions: string;
  /**
   * Conversation history. The Codex Responses API uses a typed item
   * list rather than just role+content. We model the variants the
   * adapter actually emits:
   *
   *   - `{role: "user" | "assistant", content}` — regular text turns.
   *   - `{type: "function_call", call_id, name, arguments}` — an
   *     assistant turn that requested a tool call.
   *   - `{type: "function_call_output", call_id, output}` — the tool
   *     result for a prior call_id.
   *
   * The upstream rejects `role: "tool"` with HTTP 400; that's why
   * tool results are reshaped here. System messages live in
   * `instructions`, not `input`.
   */
  input: Array<
    | {
        role: "user" | "assistant" | "developer" | "system";
        content: string;
      }
    | {
        type: "function_call";
        call_id: string;
        name: string;
        arguments: string;
      }
    | {
        type: "function_call_output";
        call_id: string;
        output: string;
      }
  >;
  /**
   * JSON-Schema function tools, same shape the orchestrator already
   * uses for the OpenAI Chat Completions adapter. Typed permissively
   * so the adapter can pass `LlmTool[]` through without translation.
   */
  tools?: unknown[];
  /**
   * ChatGPT-subscription auth requires `store: false`; the upstream
   * returns 400 `"Store must be set to false"` when this is omitted
   * or `true`. Polymath maintains its own conversation history at the
   * orchestrator layer, so this matches our semantics anyway.
   */
  store?: boolean;
  stream?: boolean;
}

/**
 * SSE events emitted by the Codex Responses endpoint. Each `data:`
 * line decodes to one of these shapes. The trailing string-keyed
 * catch-all is intentional — when the upstream introduces a new event
 * type we want the adapter to ignore it rather than crash mid-stream.
 *
 * Variants we model live (verified against
 * `chatgpt.com/backend-api/codex/responses` traffic):
 *
 *   - Lifecycle: `response.created`, `response.in_progress`,
 *     `response.completed`.
 *   - Text: `response.output_text.delta`, `response.output_text.done`.
 *   - Item lifecycle: `response.output_item.added`,
 *     `response.output_item.done`. Items have a `type` field; we
 *     dispatch tool calls via `type === "function_call"`.
 *   - Tool args: `response.function_call_arguments.delta` (streamed
 *     JSON args), `response.function_call_arguments.done` (terminator
 *     carrying the full `arguments` string).
 *   - Errors: `response.error`.
 *
 * The adapter accepts either streaming style — pure delta accumulation
 * via `function_call_arguments.delta`, or the `done` terminator — to
 * stay forward-compatible.
 */
export type CodexResponsesStreamEvent =
  | { type: "response.created"; response?: Record<string, unknown> }
  | { type: "response.in_progress"; response?: Record<string, unknown> }
  | { type: "response.output_text.delta"; delta: string; item_id?: string; output_index?: number }
  | { type: "response.output_text.done"; text?: string; item_id?: string }
  | {
      type: "response.output_item.added";
      output_index?: number;
      item: {
        id: string;
        type: "function_call" | "message" | string;
        name?: string;
        call_id?: string;
        arguments?: string;
        status?: string;
      };
    }
  | {
      type: "response.output_item.done";
      output_index?: number;
      item: {
        id: string;
        type: "function_call" | "message" | string;
        name?: string;
        call_id?: string;
        arguments?: string;
        status?: string;
      };
    }
  | {
      type: "response.function_call_arguments.delta";
      item_id: string;
      output_index?: number;
      delta: string;
    }
  | {
      type: "response.function_call_arguments.done";
      item_id: string;
      output_index?: number;
      arguments: string;
    }
  | {
      type: "response.completed";
      response: {
        usage?: {
          input_tokens: number;
          output_tokens: number;
          total_tokens: number;
        };
        finish_reason?: string;
      };
    }
  | { type: "response.error"; error: { message: string; code?: string } }
  | { type: string; [k: string]: unknown };
