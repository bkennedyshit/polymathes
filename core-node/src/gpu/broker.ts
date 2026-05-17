import { spawnSync } from "node:child_process";
import { ulid } from "ulid";
import type { Logger } from "pino";

export type GpuStatus = "idle" | "agent-active" | "user-claimed" | "draining" | "dormant";

export interface GpuState {
  status: GpuStatus;
  /** Who holds the lease right now. "agent" when Polymath is using it. */
  owner?: string;
  reason?: string;
  /** Lease token returned from claim(); required to release. */
  token?: string;
  /** When the claim expires (auto-release). */
  expires_at?: number;
  /** Snapshot of GPU state. */
  vram_used_mb?: number;
  vram_total_mb?: number;
  vram_baseline_mb?: number;
  loaded_models?: string[];
  /** True when broker is dormant (no local LLM provider). */
  dormant: boolean;
  /** Last 20 lease events. */
  history?: Array<{ ts: number; event: string; owner?: string; reason?: string }>;
}

export interface GpuBrokerOptions {
  /** Ollama base URL — "http://host:port" (no /v1 suffix). */
  ollamaUrl?: string;
  /** Poll interval for external-claim detection. */
  pollMs?: number;
  /** VRAM threshold above baseline that triggers auto-claim. */
  externalClaimThresholdMb?: number;
  /** Default lease duration if caller doesn't specify. */
  defaultHoldMs?: number;
  /** When true, broker never touches Ollama (cloud provider mode). */
  dormant?: boolean;
  logger?: Logger;
}

interface ClaimResult {
  ok: boolean;
  token?: string;
  error?: string;
  vram_free_mb?: number;
  waited_ms?: number;
}

/**
 * GpuBroker arbitrates local-GPU access between Polymath's LLM, the user's
 * video-editing workflows, and peer agents. States:
 *
 *   idle           — nobody claims, Ollama may or may not have a model warm
 *   agent-active   — Polymath is running an episode
 *   user-claimed   — explicit claim (CLI/UI/API). Agent requests get 503.
 *   draining       — evacuating Ollama ahead of a claim
 *   dormant        — broker disabled (cloud LLM, so nothing to arbitrate)
 *
 * External VRAM pressure (video editor started without calling claim) is
 * detected via nvidia-smi polling and auto-triggers a "ghost claim" with
 * owner="external".
 */
export class GpuBroker {
  private state: GpuState;
  private pollTimer: NodeJS.Timeout | null = null;
  private holdTimer: NodeJS.Timeout | null = null;
  private opts: Required<GpuBrokerOptions>;
  private history: Array<{ ts: number; event: string; owner?: string; reason?: string }> = [];

  constructor(opts: GpuBrokerOptions = {}) {
    this.opts = {
      ollamaUrl: opts.ollamaUrl ?? "http://localhost:11434",
      pollMs: opts.pollMs ?? 15_000,
      // 4 monitors + browser + video editor can spike 6-8GB above baseline
      // during normal use without it being a real "claim". Default threshold
      // needs to be well above that. Users can lower it via config.
      externalClaimThresholdMb: opts.externalClaimThresholdMb ?? 10_000,
      defaultHoldMs: opts.defaultHoldMs ?? 60 * 60 * 1000, // 1h
      dormant: opts.dormant ?? false,
      logger: opts.logger ?? (console as any),
    };
    this.state = { status: this.opts.dormant ? "dormant" : "idle", dormant: this.opts.dormant };
  }

  async init(): Promise<void> {
    if (this.opts.dormant) {
      this.log("info", "gpu broker dormant (non-local LLM provider)");
      return;
    }
    const snap = await this.snapshotGpu();
    this.state.vram_total_mb = snap.total;
    this.state.vram_used_mb = snap.used;
    this.state.vram_baseline_mb = snap.used; // baseline = what's there when we start
    this.state.loaded_models = snap.loadedModels;
    this.log("info", `gpu broker online — baseline ${snap.used}/${snap.total} MB`);
    this.pollTimer = setInterval(() => this.poll().catch(() => {}), this.opts.pollMs);
  }

  shutdown(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.holdTimer) clearTimeout(this.holdTimer);
  }

  getState(): GpuState {
    return { ...this.state, history: this.history.slice(-20) };
  }

  /**
   * Claim the GPU for a named owner. Evacuates Ollama, waits until VRAM
   * drops below target, then returns a lease token.
   */
  async claim(opts: { owner: string; reason?: string; holdMs?: number; vramNeededMb?: number }): Promise<ClaimResult> {
    if (this.opts.dormant) return { ok: true, token: "dormant" }; // no-op

    if (this.state.status === "user-claimed" && this.state.owner !== opts.owner) {
      return { ok: false, error: `already claimed by ${this.state.owner}` };
    }

    const started = Date.now();
    this.state.status = "draining";
    this.event("drain", opts.owner, opts.reason);

    try {
      await this.evacuateOllama();
    } catch (e: any) {
      this.log("warn", `evacuate failed: ${e?.message ?? e}`);
    }

    // Wait for VRAM to drop. Target = baseline + 1GB buffer.
    const target = (this.state.vram_baseline_mb ?? 0) + 1000;
    const drained = await this.waitForVramFree(target, 15_000);

    const token = ulid();
    const hold = opts.holdMs ?? this.opts.defaultHoldMs;
    this.state = {
      ...this.state,
      status: "user-claimed",
      owner: opts.owner,
      reason: opts.reason,
      token,
      expires_at: Date.now() + hold,
    };
    this.event("claim", opts.owner, opts.reason);

    // Auto-release when hold expires.
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => {
      if (this.state.token === token) this.releaseInternal("expired");
    }, hold);

    const snap = await this.snapshotGpu();
    return { ok: true, token, vram_free_mb: snap.total - snap.used, waited_ms: Date.now() - started };
  }

  async release(token: string): Promise<{ ok: boolean; error?: string }> {
    if (this.opts.dormant) return { ok: true };
    if (this.state.token !== token && token !== "force") {
      return { ok: false, error: "invalid or stale lease token" };
    }
    this.releaseInternal("released");
    return { ok: true };
  }

  private releaseInternal(cause: string): void {
    this.event(cause, this.state.owner, this.state.reason);
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    this.state = {
      ...this.state,
      status: "idle",
      owner: undefined,
      reason: undefined,
      token: undefined,
      expires_at: undefined,
    };
  }

  /**
   * Fire `keep_alive: 0` against every resident Ollama model so they unload
   * from VRAM immediately.
   */
  async evacuateOllama(): Promise<void> {
    if (this.opts.dormant) return;
    try {
      const ps = await fetch(this.opts.ollamaUrl + "/api/ps", { signal: AbortSignal.timeout(3000) }).then(r => r.json());
      const resident: Array<{ name: string }> = ps?.models ?? [];
      await Promise.all(
        resident.map((m) =>
          fetch(this.opts.ollamaUrl + "/api/generate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: m.name, keep_alive: 0, prompt: "" }),
            signal: AbortSignal.timeout(5000),
          }).catch(() => {}),
        ),
      );
      this.log("info", `evacuated ${resident.length} Ollama model(s)`);
    } catch (e: any) {
      // Ollama not reachable — not fatal, just means nothing to evacuate.
    }
  }

  /**
   * Poll GPU state until used VRAM drops below `targetMb` or timeout.
   */
  async waitForVramFree(targetMb: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snap = await this.snapshotGpu();
      if (snap.used <= targetMb) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  /**
   * Get current GPU snapshot. Prefers nvidia-smi, falls back to Ollama /api/ps
   * on systems without nvidia-smi (AMD / Apple Silicon / non-GPU hosts).
   */
  private async snapshotGpu(): Promise<{ used: number; total: number; loadedModels: string[] }> {
    let used = 0, total = 0;
    try {
      const out = spawnSync("nvidia-smi", ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"], { encoding: "utf-8", timeout: 2000 });
      if (out.status === 0) {
        // Take the first GPU only — users with multi-GPU aren't the target case.
        const firstLine = out.stdout.trim().split("\n")[0] ?? "";
        const [u, t] = firstLine.split(",").map((s) => parseInt(s.trim(), 10));
        if (!isNaN(u)) used = u;
        if (!isNaN(t)) total = t;
      }
    } catch { /* nvidia-smi absent — use Ollama-only view */ }

    let loadedModels: string[] = [];
    try {
      const ps = await fetch(this.opts.ollamaUrl + "/api/ps", { signal: AbortSignal.timeout(1500) }).then(r => r.json());
      loadedModels = (ps?.models ?? []).map((m: any) => m.name).filter(Boolean);
      if (total === 0) {
        // Approximate from Ollama's own accounting when nvidia-smi isn't available.
        const sumBytes = (ps?.models ?? []).reduce((acc: number, m: any) => acc + (m.size_vram ?? 0), 0);
        used = Math.round(sumBytes / 1024 / 1024);
        total = Math.max(used, 1); // avoid div-by-zero
      }
    } catch { /* Ollama offline */ }

    return { used, total, loadedModels };
  }

  /**
   * Called by poll loop. Detects external VRAM pressure and, if severe, takes
   * a "ghost claim" on behalf of owner=external so agent requests back off.
   * Also auto-releases ghost claims when VRAM drops back below threshold.
   */
  private async poll(): Promise<void> {
    const snap = await this.snapshotGpu();
    this.state.vram_used_mb = snap.used;
    this.state.vram_total_mb = snap.total;
    this.state.loaded_models = snap.loadedModels;

    const baseline = this.state.vram_baseline_mb ?? 0;
    const ollamaMB = snap.loadedModels.length > 0 ? /* rough */ 5000 : 0;
    const externalPressure = snap.used - baseline - ollamaMB;

    // Auto-release ghost claim when external VRAM drops back.
    if (this.state.status === "user-claimed" && this.state.owner === "external") {
      if (externalPressure < this.opts.externalClaimThresholdMb / 2) {
        this.event("ghost-release", "external", `VRAM back to normal (${externalPressure}MB pressure)`);
        this.state = { ...this.state, status: "idle", owner: undefined, reason: undefined, token: undefined, expires_at: undefined };
      }
      return;
    }

    if (this.state.status === "user-claimed" || this.state.status === "draining") return;

    if (externalPressure > this.opts.externalClaimThresholdMb) {
      this.state.status = "user-claimed";
      this.state.owner = "external";
      this.state.reason = `detected ${externalPressure}MB external VRAM use above baseline`;
      this.state.token = "external";
      this.event("ghost-claim", "external", this.state.reason);
    }
  }

  /** Lease check for callers (agent episode start, etc). */
  canAgentRun(): { ok: boolean; reason?: string } {
    if (this.opts.dormant) return { ok: true };
    if (this.state.status === "user-claimed" || this.state.status === "draining") {
      return { ok: false, reason: `GPU is ${this.state.status} by ${this.state.owner ?? "unknown"} (${this.state.reason ?? "no reason"})` };
    }
    return { ok: true };
  }

  private event(name: string, owner?: string, reason?: string): void {
    this.history.push({ ts: Date.now(), event: name, owner, reason });
    if (this.history.length > 200) this.history = this.history.slice(-100);
    this.log("info", `[gpu] ${name}${owner ? " owner=" + owner : ""}${reason ? " reason=" + reason : ""}`);
  }

  private log(level: "info" | "warn" | "error", msg: string): void {
    const l: any = this.opts.logger;
    if (l && typeof l[level] === "function") l[level](msg);
  }
}
