import { readFileSync, existsSync } from "node:fs";
import type { SkillDef } from "./registry.js";
import { parseFrontmatter } from "./registry.js";
import { spawnSubagent, type SubagentOpts } from "../sessions/subagent.js";
import type { EpisodeContext } from "../orchestrator/loop.js";
import type { GpuBroker } from "../gpu/broker.js";
import type { MediaEpisodic } from "../memory/media_episodic.js";
import type { MediaWorkflow } from "../memory/media_workflow.js";
import { inferFromPath } from "../memory/path_inference.js";

export interface InvokeSkillDeps {
  gpuBroker?: GpuBroker;
  /** Ollama base URL (no /v1 suffix) — used to pre-pull the specialist model. */
  ollamaUrl?: string;
  /** The parent agent's configured model — what we swap back to after the skill. */
  parentModel?: string;
  /** Optional: media catalog for auto-trace bookkeeping. */
  mediaEpisodic?: MediaEpisodic;
  /** Optional: workflow log for auto-trace bookkeeping. */
  mediaWorkflow?: MediaWorkflow;
}

/**
 * Map a skill's name to a workflow step. Lets media.trace events stay
 * consistent across skill invocations without each skill reimplementing
 * the call.
 */
function inferWorkflowStep(skillName: string): string {
  const lower = skillName.toLowerCase();
  if (/(^|[\-_])edit/.test(lower) || /editor/.test(lower)) return "edit";
  if (/reel/.test(lower)) return "reel";
  if (/analy[sz]/.test(lower)) return "analyze";
  if (/crop|resize|reframe/.test(lower)) return "crop";
  if (/(^|[\-_])post/.test(lower) || /publish/.test(lower)) return "post";
  if (/repurpose|remix/.test(lower)) return "repurpose";
  return `skill:${skillName}`;
}

/**
 * Heuristic: does the input look like an absolute file path the agent is
 * asking the skill to process? Catches Windows (D:\...) and POSIX (/...).
 * False positives are cheap (just a no-op trace); false negatives mean
 * the skill caller has to trace manually, which is also fine.
 */
function looksLikePath(input: string): string | null {
  if (!input) return null;
  // Pull the first whitespace-delimited token that looks like a path.
  const tokens = input.split(/\s+/);
  for (const t of tokens) {
    const cleaned = t.replace(/^["'`]|["'`]$/g, "");
    if (/^[a-zA-Z]:[\\\/]/.test(cleaned) || cleaned.startsWith("/") || cleaned.startsWith("~/")) {
      return cleaned;
    }
  }
  return null;
}

/**
 * Invoke a skill as a subagent. If the skill declares a `model:` in its
 * frontmatter, Polymath:
 *   1. Evacuates its own model from VRAM (via GPU broker)
 *   2. Pre-pulls the specialist model into Ollama
 *   3. Runs the subagent with a per-episode `modelOverride`
 *   4. Evacuates the specialist model
 *   5. Lazy-reloads the parent model on the next chat turn
 *
 * If the skill input looks like a file path AND the workflow tracker is
 * wired in, also auto-records a `media.trace` event so future queries
 * like "what raw sessions haven't I edited yet?" work without each
 * skill having to remember to log.
 */
export async function invokeSkill(
  skill: SkillDef,
  args: { input: string },
  ctx: Omit<EpisodeContext, "sessionId"> & { sessionId: string },
  deps: InvokeSkillDeps = {},
): Promise<string> {
  const content = readFileSync(skill.prompt_file, "utf-8");
  const { body } = parseFrontmatter(content);

  const needsSwap = Boolean(skill.model && skill.model !== deps.parentModel);
  let claimToken: string | undefined;
  // Promise we'll await right before spawning the subagent. Lets us run
  // the model pre-pull concurrently with reading the skill body, building
  // the soul, etc. — saves a couple hundred ms on every model-swap skill.
  let prePullPromise: Promise<{ ok: boolean; error?: string }> | null = null;

  if (needsSwap && deps.gpuBroker) {
    const claim = await deps.gpuBroker.claim({
      owner: `skill:${skill.name}`,
      reason: `swap to ${skill.model}`,
      holdMs: 60 * 60 * 1000,
    });
    if (!claim.ok) {
      return `Could not claim GPU for skill "${skill.name}": ${claim.error ?? "unknown"}`;
    }
    claimToken = claim.token;

    // Fire the pre-pull but DON'T await yet — let it overlap with subagent
    // ctx assembly (skill body parse, soul concat, etc.).
    const url = (deps.ollamaUrl ?? "http://localhost:11434").replace(/\/+$/, "") + "/api/generate";
    prePullPromise = (async () => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: skill.model, prompt: "", keep_alive: "30m", stream: false }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    })();
  }

  // Run the subagent with the specialist model active.
  const opts: SubagentOpts = {
    parentSessionId: ctx.sessionId,
    ctx: {
      ...ctx,
      soul: body + "\n\n" + (ctx.soul ?? ""),
      modelOverride: needsSwap ? skill.model : undefined,
    },
  };

  // Now block on the pre-pull (if any) — by this point Ollama has had a
  // head start while we built the subagent context.
  if (prePullPromise) {
    const pull = await prePullPromise;
    if (!pull.ok) {
      if (deps.gpuBroker && claimToken) await deps.gpuBroker.release(claimToken);
      return `Failed to load specialist model "${skill.model}": ${pull.error ?? "unknown"}`;
    }
  }

  let resultText: string;
  let succeeded = false;
  try {
    const result = await spawnSubagent(args.input, opts);
    resultText = result.finalAnswer ?? `Skill "${skill.name}" completed with status: ${result.status}`;
    succeeded = result.status === "completed";
    return resultText;
  } finally {
    // ─── Auto-trace ────────────────────────────────────────────────
    // If the skill's input pointed at a real file AND we have a workflow
    // tracker, record the step. Best-effort — never throws into the parent.
    if (succeeded && deps.mediaWorkflow) {
      try {
        const candidatePath = looksLikePath(args.input);
        if (candidatePath && existsSync(candidatePath)) {
          // Auto-register the source file in the catalog if not present
          // (covers the "skill ran on a fresh file" case).
          let sourceId: string | undefined;
          if (deps.mediaEpisodic) {
            const existing = deps.mediaEpisodic.get(candidatePath);
            if (existing) {
              sourceId = existing.id;
            } else {
              const inferred = inferFromPath(candidatePath);
              if (!inferred.skipped) {
                sourceId = deps.mediaEpisodic.upsert({
                  path: candidatePath,
                  brand: inferred.brand,
                  category: inferred.category,
                  intent: inferred.intent,
                  metadata: inferred.metadata,
                });
              }
            }
          }
          if (sourceId) {
            deps.mediaWorkflow.record({
              source_id: sourceId,
              derived_id: null,
              step: inferWorkflowStep(skill.name),
              tool: skill.name,
              session_id: ctx.sessionId,
              note: undefined,
            });
          }
        }
      } catch { /* trace is bookkeeping — never fail a skill on it */ }
    }

    if (needsSwap && deps.gpuBroker) {
      try { await deps.gpuBroker.evacuateOllama(); } catch { /* ignore */ }
      if (claimToken) await deps.gpuBroker.release(claimToken);
    }
  }
}
