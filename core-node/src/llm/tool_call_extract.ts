import type { ToolCall } from "./types.js";

/**
 * Normalize content that contains embedded tool-call syntax back into proper
 * ToolCall[] objects.
 *
 * Background: different open-source models emit tool calls through different
 * conventions. When the Ollama OpenAI-compat bridge (or any OpenAI-compat
 * server) fails to translate a model-specific format into the native
 * `tool_calls` field, the raw syntax ends up in `content`. Left unchecked,
 * the orchestrator treats that content as a final answer and ships it to the
 * user — producing the "bot replies with JSON" bug.
 *
 * Supported formats:
 *   - Hermes / Nous: <tool_call>{"name":"x","arguments":{...}}</tool_call>
 *   - Hermes variant: <tool_call>{"name":"x","parameters":{...}}</tool_call>
 *   - Bare JSON block at start/end of message: {"name":"x","arguments":{...}}
 *   - Markdown-fenced JSON: ```json\n{"name":"x","arguments":{...}}\n```
 *   - Multiple concurrent calls wrapped in <tool_calls>[...]</tool_calls>
 *
 * Returns { cleanedContent, extractedCalls }:
 *   - cleanedContent: the content with tool-call syntax stripped out. If the
 *     original was essentially pure tool-call syntax, returns "".
 *   - extractedCalls: normalized ToolCall[] ready to be merged with any
 *     native tool_calls the model emitted on the same turn.
 */
export interface ExtractedToolCalls {
  cleanedContent: string;
  extractedCalls: ToolCall[];
}

function safeParse(json: string): any | null {
  try { return JSON.parse(json); } catch { return null; }
}

/**
 * Strip fenced code blocks whose contents look like raw tool-schema dumps
 * (e.g. `{"type":"function","function":{...}}`). Small models sometimes
 * answer "what can you do?" by regurgitating the OpenAI tool-schema JSON
 * verbatim. That's never something we want shown to the user.
 */
function stripSchemaFences(content: string): { remaining: string; stripped: number } {
  let stripped = 0;
  const remaining = content.replace(/```(?:json)?\s*([\s\S]*?)```/g, (match, body: string) => {
    const trimmed = body.trim();
    // Heuristic: block contains `"type": "function"` OR `"function":` with a name/description → schema dump
    if (/"type"\s*:\s*"function"/.test(trimmed) || /"function"\s*:\s*\{[^}]*"name"/.test(trimmed)) {
      stripped++;
      return "";
    }
    return match;
  });
  return { remaining, stripped };
}

function normalizeSingleCall(raw: any, idx: number): ToolCall | null {
  if (!raw || typeof raw !== "object") return null;
  const name = raw.name ?? raw.function?.name ?? raw.tool ?? raw.tool_name;
  if (!name || typeof name !== "string") return null;
  const argsObj = raw.arguments ?? raw.parameters ?? raw.args ?? raw.input ?? raw.function?.arguments ?? {};
  const argsStr = typeof argsObj === "string" ? argsObj : JSON.stringify(argsObj);
  return {
    id: raw.id ?? `extracted_${Date.now()}_${idx}`,
    type: "function" as const,
    function: { name, arguments: argsStr },
  };
}

/**
 * Look for `<tool_call>...</tool_call>` XML tags and pull out any JSON
 * inside. Also handles `<tool_calls>[...]</tool_calls>` plural form.
 */
function extractXmlStyle(content: string): { remaining: string; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  let remaining = content;
  let idx = 0;

  // <tool_calls>[...]</tool_calls> (plural)
  remaining = remaining.replace(/<tool_calls>([\s\S]*?)<\/tool_calls>/gi, (_m, inner: string) => {
    const parsed = safeParse(inner.trim());
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const tc = normalizeSingleCall(item, idx++);
        if (tc) calls.push(tc);
      }
    }
    return "";
  });

  // <tool_call>...</tool_call> (singular, can appear multiple times)
  remaining = remaining.replace(/<tool_call>([\s\S]*?)<\/tool_call>/gi, (_m, inner: string) => {
    const parsed = safeParse(inner.trim());
    if (parsed) {
      const tc = normalizeSingleCall(parsed, idx++);
      if (tc) calls.push(tc);
    }
    return "";
  });

  return { remaining, calls };
}

/**
 * Look for fenced JSON blocks that describe a tool call.
 *   ```json
 *   {"name":"skill.x","arguments":{...}}
 *   ```
 * Or without the language tag.
 */
function extractFencedJson(content: string): { remaining: string; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  let idx = 0;
  const remaining = content.replace(/```(?:json)?\s*([\s\S]*?)```/g, (match, body: string) => {
    const parsed = safeParse(body.trim());
    if (parsed) {
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      const extracted: ToolCall[] = [];
      for (const c of candidates) {
        const tc = normalizeSingleCall(c, idx++);
        if (tc) extracted.push(tc);
      }
      if (extracted.length) {
        calls.push(...extracted);
        return ""; // strip the fence if it was purely a tool call
      }
    }
    return match; // leave markdown code blocks alone if they weren't tool calls
  });
  return { remaining, calls };
}

/**
 * Scan for bare JSON-object tool-call syntax. This only fires if:
 *   a) the content, after trimming and stripping whitespace, starts with `{`
 *   b) the parsed JSON looks like a tool call (has .name + (.arguments|.parameters))
 * This is intentionally conservative — we don't want to eat a legit JSON
 * answer from the user's perspective.
 */
function extractBareJson(content: string): { remaining: string; calls: ToolCall[] } {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { remaining: content, calls: [] };
  }
  const parsed = safeParse(trimmed);
  if (!parsed) return { remaining: content, calls: [] };
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  const calls: ToolCall[] = [];
  let idx = 0;
  for (const c of candidates) {
    const tc = normalizeSingleCall(c, idx++);
    if (tc) calls.push(tc);
  }
  if (calls.length === 0) return { remaining: content, calls: [] };
  // Only eat the content if EVERY top-level object looked like a tool call.
  if (calls.length !== candidates.length) return { remaining: content, calls: [] };
  return { remaining: "", calls };
}

export function extractToolCalls(content: string): ExtractedToolCalls {
  if (!content) return { cleanedContent: "", extractedCalls: [] };

  let cur = content;
  const all: ToolCall[] = [];

  // First strip any code blocks that are just tool-schema dumps — these are
  // never useful to show the user and would confuse downstream extraction.
  const schemaStrip = stripSchemaFences(cur);
  cur = schemaStrip.remaining;

  const xml = extractXmlStyle(cur);
  cur = xml.remaining; all.push(...xml.calls);

  const fenced = extractFencedJson(cur);
  cur = fenced.remaining; all.push(...fenced.calls);

  const bare = extractBareJson(cur);
  cur = bare.remaining; all.push(...bare.calls);

  return { cleanedContent: cur.trim(), extractedCalls: all };
}
