import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { GpuBroker } from "../../gpu/broker.js";

let broker: GpuBroker | null = null;

export function setGpuBroker(b: GpuBroker): void {
  broker = b;
}

export function register(registry: ToolRegistry): void {
  registry.register({
    name: "gpu.status",
    description:
      "Report current GPU / VRAM state and who holds the GPU lease. " +
      "Use this before kicking off GPU-heavy work to see what's free.",
    parameters: z.object({}),
    async handler() {
      if (!broker) return { error: "gpu broker not initialized" };
      return broker.getState();
    },
    toolset: "gpu",
  });

  registry.register({
    name: "gpu.release",
    description:
      "Release the agent's hold on the GPU and evacuate any loaded LLM from VRAM. " +
      "Use this before delegating work to another GPU-heavy process (video editor, " +
      "peer agent, upscaler). After calling this you cannot make LLM calls until " +
      "gpu.reclaim is run or a chat turn re-warms the model.",
    parameters: z.object({
      reason: z.string().describe("Short label for who/what you're handing off to, e.g. 'resolve-export' or 'peer-agent-upscale'."),
      hold_minutes: z.number().optional().describe("How long you expect the handoff to last. Defaults to 60 minutes."),
    }),
    async handler(args: unknown) {
      if (!broker) return { ok: false, error: "gpu broker not initialized" };
      const { reason, hold_minutes } = args as { reason: string; hold_minutes?: number };
      const res = await broker.claim({
        owner: "agent-released",
        reason,
        holdMs: (hold_minutes ?? 60) * 60 * 1000,
      });
      return res;
    },
    toolset: "gpu",
  });

  registry.register({
    name: "gpu.reclaim",
    description:
      "Return control of the GPU to the agent. Only valid if a prior gpu.release " +
      "was made. The LLM will lazy-reload into VRAM on the next chat turn.",
    parameters: z.object({
      token: z.string().describe("The lease token returned by gpu.release."),
    }),
    async handler(args: unknown) {
      if (!broker) return { ok: false, error: "gpu broker not initialized" };
      const { token } = args as { token: string };
      return broker.release(token);
    },
    toolset: "gpu",
  });

  registry.register({
    name: "gpu.handoff",
    description:
      "Fire a task at a peer agent's gateway over HTTP, evacuating the local GPU " +
      "first so the peer has full VRAM to work with. Reclaims automatically when " +
      "the peer returns. Use this for delegating GPU-heavy subtasks like video " +
      "editing, image generation, or batch VLM tagging to a specialized agent.",
    parameters: z.object({
      target_url: z.string().describe("Peer agent URL, e.g. http://localhost:18790"),
      target_token: z.string().optional().describe("Bearer token for the peer agent, if it requires auth."),
      task: z.string().describe("The task prompt to send to the peer."),
      timeout_seconds: z.number().optional().describe("Max time to wait for peer to complete. Default 1800 (30m)."),
    }),
    async handler(args: unknown) {
      if (!broker) return { ok: false, error: "gpu broker not initialized" };
      const { target_url, target_token, task, timeout_seconds } = args as {
        target_url: string; target_token?: string; task: string; timeout_seconds?: number;
      };
      const claim = await broker.claim({ owner: "peer-agent", reason: "handoff to " + target_url });
      if (!claim.ok) return { ok: false, error: "claim failed: " + claim.error };
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (target_token) headers.authorization = "Bearer " + target_token;
        const res = await fetch(target_url.replace(/\/+$/, "") + "/api/chat", {
          method: "POST",
          headers,
          body: JSON.stringify({ text: task }),
          signal: AbortSignal.timeout((timeout_seconds ?? 1800) * 1000),
        });
        const data = await res.json();
        await broker.release(claim.token!);
        return { ok: res.ok, peer_response: data, status: res.status };
      } catch (e: any) {
        await broker.release(claim.token!);
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
    toolset: "gpu",
  });
}
