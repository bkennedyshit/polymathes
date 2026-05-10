import { ulid } from "ulid";
import { runEpisode } from "../orchestrator/loop.js";
import type { EpisodeContext, EpisodeResult } from "../orchestrator/loop.js";

const MAX_DEPTH = 3;

export interface SubagentOpts {
  parentSessionId: string;
  ctx: Omit<EpisodeContext, "sessionId">;
  toolset?: string;
  maxIterations?: number;
  signal?: AbortSignal;
}

function getDepth(sessionId: string): number {
  return sessionId.split("/").length - 1;
}

export async function spawnSubagent(task: string, opts: SubagentOpts): Promise<EpisodeResult> {
  const depth = getDepth(opts.parentSessionId);
  if (depth >= MAX_DEPTH) {
    return {
      id: ulid(),
      status: "failed",
      finalAnswer: null,
      iterations: 0,
      totalTokens: { prompt: 0, completion: 0 },
    };
  }

  const childSessionId = `${opts.parentSessionId}/${ulid()}`;

  const ctx: EpisodeContext = {
    ...opts.ctx,
    sessionId: childSessionId,
    maxIterations: opts.maxIterations ?? opts.ctx.maxIterations,
    signal: opts.signal ?? opts.ctx.signal,
  };

  return runEpisode(task, ctx);
}
