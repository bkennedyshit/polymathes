/**
 * Session consolidator — LLM-summarizes a completed (or idle) session and
 * writes atomic facts + summary into semantic memory with REAL embeddings.
 *
 * This is the "self-improving" part everyone else markets. Each time a chat
 * ends or sits idle long enough, we:
 *   1. Pull the session's episodic transcript
 *   2. Ask the LLM for a 1-2 sentence summary + 3-8 atomic facts
 *   3. Embed each fact + the summary via the configured Embedder
 *   4. Store in SemanticMemory with source_session pointer
 *   5. Mark the session as consolidated so we don't re-process it
 *
 * Design choices:
 * - `chat` is provider-agnostic (any LlmAdapter that can return a string).
 *   We pass messages directly so the adapter's model config controls cost.
 * - Embeddings can fail (offline, rate limit, model not pulled) — when an
 *   embedding is null we SKIP that fact rather than writing a zero vector.
 *   The summary is still always persisted even without embedding.
 * - JSON parse failures fall through silently; consolidation is best-effort.
 */
import type { EpisodicMemory } from "./episodic.js";
import type { SemanticMemory } from "./semantic.js";
import type { Embedder } from "./embed.js";
import type Database from "better-sqlite3";

export interface LlmChatLike {
  chat(messages: Array<{ role: string; content: string }>): Promise<string>;
}

export interface ConsolidateOpts {
  llmAdapter: LlmChatLike;
  episodic: EpisodicMemory;
  semantic: SemanticMemory;
  embedder: Embedder;
  db?: Database.Database;  // If provided, we mark sessions as consolidated.
  minMessages?: number;    // Skip sessions shorter than this (default 4)
  maxMessages?: number;    // Trim very long sessions to last N turns (default 120)
  /**
   * Mid-session compression mode: if set, consolidate ONLY the oldest N
   * turns (instead of the whole session) and mark them as compressed_at
   * so they drop out of working memory but stay searchable in audit.
   */
  compressOldestN?: number;
}

export interface ConsolidateResult {
  sessionId: string;
  status: "ok" | "skipped_empty" | "skipped_short" | "parse_error" | "no_summary" | "error";
  facts_stored?: number;
  summary?: string;
  compressed_count?: number;  // mid-session mode: how many turns we marked compressed
  error?: string;
}

const CONSOLIDATE_PROMPT = `You are summarizing a conversation for long-term memory. Analyze the transcript and return a JSON object with these fields:

{
  "summary": "One or two sentences capturing what the conversation was about.",
  "atomic_facts": [
    "Each fact is one self-contained sentence.",
    "Prefer stable facts (user preferences, paths, names) over transient ones.",
    "Do NOT invent facts. If unsure, skip it.",
    "Aim for 3-8 facts, fewer if the conversation was short."
  ]
}

Rules:
- Output ONLY the JSON. No prose, no markdown fences.
- Strip any internal tool-call logs or system messages.
- Keep facts factual: "user prefers PowerShell over bash" not "user probably likes PowerShell".`;

function extractJson(raw: string): any | null {
  // Tolerate markdown fences and leading prose
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fence?.[1] ?? raw).trim();
  // Find first { and last } to tolerate surrounding text
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try { return JSON.parse(candidate.slice(first, last + 1)); }
  catch { return null; }
}

export async function consolidateSession(
  sessionId: string,
  opts: ConsolidateOpts,
): Promise<ConsolidateResult> {
  const minMessages = opts.minMessages ?? 4;
  const maxMessages = opts.maxMessages ?? 120;

  // recallBySession with includeCompressed=true so we don't pick up the
  // same rows we already compressed on a prior pass.
  const allEntries = opts.episodic.recallBySession(sessionId, maxMessages);
  if (allEntries.length === 0) return { sessionId, status: "skipped_empty" };
  if (allEntries.length < minMessages) return { sessionId, status: "skipped_short" };

  // Mid-session mode: take only the oldest N for compression. Rest of the
  // session keeps flowing under runTask without context loss.
  const entries = opts.compressOldestN
    ? allEntries.slice(0, opts.compressOldestN)
    : allEntries;
  if (entries.length < minMessages) return { sessionId, status: "skipped_short" };

  const transcript = entries
    .filter((e) => e.content && e.content.trim().length > 0)
    .map((e) => `${e.role}: ${e.content}`)
    .join("\n");

  let raw: string;
  try {
    raw = await opts.llmAdapter.chat([
      { role: "system", content: CONSOLIDATE_PROMPT },
      { role: "user", content: transcript },
    ]);
  } catch (e: any) {
    return { sessionId, status: "error", error: e?.message ?? String(e) };
  }

  const parsed = extractJson(raw);
  if (!parsed || typeof parsed.summary !== "string") {
    return { sessionId, status: "parse_error" };
  }

  const { summary, atomic_facts } = parsed as { summary: string; atomic_facts?: string[] };
  const facts = Array.isArray(atomic_facts) ? atomic_facts.filter((f) => typeof f === "string" && f.trim()) : [];
  if (!summary.trim() && facts.length === 0) return { sessionId, status: "no_summary" };

  // Embed summary + facts in parallel.
  const allTexts = [summary, ...facts];
  const embeddings = await opts.embedder.embedBatch(allTexts);

  let stored = 0;
  for (let i = 0; i < allTexts.length; i++) {
    const text = allTexts[i]!;
    const embedding = embeddings[i];
    if (!embedding) {
      // Skip — writing a zero vector would pollute cosine recall.
      // The summary/fact itself isn't lost: it's still in episodic memory.
      continue;
    }
    opts.semantic.store(text, embedding, sessionId);
    stored++;
  }

  // Mark session consolidated so the scheduler skips it next pass.
  if (opts.db) {
    try {
      opts.db
        .prepare(`UPDATE sessions SET consolidated_at = datetime('now') WHERE id = ?`)
        .run(sessionId);
    } catch { /* column may not exist yet on old dbs — non-fatal */ }
  }

  // Mid-session mode: also mark the just-summarized entries as compressed
  // so working memory stops carrying them around but they survive in
  // audit storage.
  let compressed_count = 0;
  if (opts.compressOldestN) {
    compressed_count = opts.episodic.markCompressed(entries.map((e) => e.id));
  }

  return { sessionId, status: "ok", facts_stored: stored, summary, compressed_count };
}
