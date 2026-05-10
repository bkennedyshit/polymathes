import type { EpisodicMemory } from "./episodic.js";
import type { SemanticMemory } from "./semantic.js";

export interface LlmAdapter {
  chat(messages: Array<{ role: string; content: string }>): Promise<string>;
}

export interface ConsolidateOpts {
  llmAdapter: LlmAdapter;
  episodic: EpisodicMemory;
  semantic: SemanticMemory;
  config?: { embeddingDim?: number };
}

export async function consolidateSession(sessionId: string, opts: ConsolidateOpts): Promise<void> {
  const entries = opts.episodic.recallBySession(sessionId, 200);
  if (entries.length === 0) return;

  const transcript = entries.map((e) => `${e.role}: ${e.content}`).join("\n");

  const prompt = `Summarize this conversation. Return JSON: {"summary":"1-2 sentences","atomic_facts":["fact1","fact2"],"profile_diff":null}

${transcript}`;

  const raw = await opts.llmAdapter.chat([{ role: "user", content: prompt }]);
  const parsed = JSON.parse(raw) as {
    summary: string;
    atomic_facts: string[];
    profile_diff: string | null;
  };

  const dim = opts.config?.embeddingDim ?? 384;
  const zeroEmbed = new Float32Array(dim);

  opts.semantic.store(parsed.summary, zeroEmbed, sessionId);
  for (const fact of parsed.atomic_facts) {
    opts.semantic.store(fact, zeroEmbed, sessionId);
  }
}
