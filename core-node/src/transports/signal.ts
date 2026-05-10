import { spawn, type ChildProcess } from "node:child_process";
import type { Transport } from "./base.js";
import type { PairingManager } from "../security/pairing.js";

export interface SignalTransportOptions {
  /** Absolute path to signal-cli binary. Must be installed separately. */
  signalCliPath?: string;
  /** The phone number registered with Signal (in +E.164 format). */
  account: string;
  onMessage: (ctx: { channel: string; senderId: string; text: string; sessionId: string }) => Promise<string>;
}

/**
 * Signal transport.
 *
 * Runs `signal-cli -a <account> jsonRpc` as a subprocess. signal-cli exposes a newline-delimited
 * JSON-RPC interface over stdin/stdout when invoked this way. We send commands via stdin and parse
 * messages off stdout.
 *
 * Requirements on the user side:
 *   1. Install signal-cli (https://github.com/AsamK/signal-cli)
 *   2. Register your phone and link/verify it ONCE manually:
 *        signal-cli -a +15551234567 register
 *        signal-cli -a +15551234567 verify <code>
 *   3. Set `account` in polymath.json to that +E.164 number
 *
 * See docs/CHANNELS.md for the full setup walkthrough.
 */
export class SignalTransport implements Transport {
  name = "signal";

  private opts: SignalTransportOptions;
  private proc: ChildProcess | null = null;
  private buffer = "";
  private rpcId = 0;
  private pairingManager: PairingManager | null = null;
  private running = false;

  constructor(opts: SignalTransportOptions) {
    this.opts = opts;
  }

  setPairingManager(pm: PairingManager): void {
    this.pairingManager = pm;
  }

  async start(): Promise<void> {
    const bin = this.opts.signalCliPath ?? "signal-cli";
    this.proc = spawn(bin, ["-a", this.opts.account, "jsonRpc"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.on("error", (err) => {
      console.error(`[signal] failed to spawn ${bin}: ${err.message}. Is signal-cli installed? See docs/CHANNELS.md`);
    });

    this.proc.on("exit", (code) => {
      if (this.running) {
        console.error(`[signal] signal-cli exited unexpectedly (code ${code})`);
      }
    });

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf-8");
      this.drainBuffer();
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf-8").trim();
      if (line) console.error(`[signal:stderr] ${line}`);
    });

    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      // Give it a moment, then force
      await new Promise((r) => setTimeout(r, 500));
      if (!this.proc.killed) this.proc.kill("SIGKILL");
    }
    this.proc = null;
  }

  /**
   * Send a Signal message. sessionId is the recipient's +E.164 number or group id.
   */
  async send(sessionId: string, text: string): Promise<void> {
    this.rpc("send", {
      recipient: [sessionId],
      message: text,
    });
  }

  /** Fire-and-forget JSON-RPC request. Responses come back via stdout as notifications we ignore. */
  private rpc(method: string, params: unknown): void {
    if (!this.proc?.stdin || !this.running) return;
    this.rpcId++;
    const req = JSON.stringify({ jsonrpc: "2.0", id: this.rpcId, method, params });
    this.proc.stdin.write(req + "\n");
  }

  /** Parse newline-delimited JSON from stdout and dispatch incoming messages. */
  private drainBuffer(): void {
    while (true) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) return;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        void this.handle(msg).catch((err) => {
          console.error("[signal] handle error:", err?.message ?? err);
        });
      } catch {
        // non-JSON noise — signal-cli sometimes emits plain logs
      }
    }
  }

  private async handle(msg: any): Promise<void> {
    // JSON-RPC notification from signal-cli looks like:
    // { method: "receive", params: { envelope: { source, dataMessage: { message } } } }
    if (msg.method !== "receive") return;
    const env = msg.params?.envelope;
    if (!env) return;

    const senderId = env.source ?? env.sourceNumber;
    const text: string | undefined = env.dataMessage?.message;
    if (!senderId || !text) return;

    const sessionId = senderId;

    // Pairing flow
    if (this.pairingManager) {
      const status = this.pairingManager.checkSender(this.name, senderId);
      if (status === "unknown") {
        const code = this.pairingManager.createPairing(this.name, senderId);
        await this.send(sessionId,
          `Hi! I need to verify you. Your pairing code is: ${code}.\n` +
          `The operator can approve with: polymath pairing approve signal ${code}`,
        );
        return;
      }
      if (status === "pending") {
        await this.send(sessionId, "Your pairing is still pending approval.");
        return;
      }
    }

    const response = await this.opts.onMessage({
      channel: this.name,
      senderId,
      text,
      sessionId,
    });
    await this.send(sessionId, response);
  }
}
