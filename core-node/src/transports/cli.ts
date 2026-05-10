import * as readline from "node:readline";
import type { Transport } from "./base.js";

export interface CliTransportOptions {
  repl?: boolean;
  verbose?: boolean;
  onInput?: (text: string, sessionId: string) => Promise<string>;
  getSkills?: () => Array<{ name: string; description: string }>;
  getCronJobs?: () => Array<{ id: string; cron_expr: string; task?: string }>;
  getChannels?: () => Array<{ name: string; status: string }>;
  reconnectMcp?: (name: string) => Promise<boolean>;
}

export const SLASH_COMMANDS: Record<string, string> = {
  "/help": "Show available commands",
  "/tools": "List registered tools",
  "/history": "Show conversation history",
  "/clear": "Clear conversation history",
  "/exit": "Exit the REPL",
  "/policy": "Show current sandbox policy",
  "/metrics": "Show runtime metrics",
  "/skills": "List discovered skills",
  "/cron": "List cron jobs",
  "/channels": "List active transports",
  "/reconnect": "Reconnect an MCP server by name",
};

export function parseSlashCommand(input: string): { command: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return { command: trimmed, args: "" };
  return { command: trimmed.slice(0, spaceIdx), args: trimmed.slice(spaceIdx + 1).trim() };
}

export class CliTransport implements Transport {
  name = "cli";
  private rl: readline.Interface | null = null;
  private running = false;
  private abortController: AbortController | null = null;
  private opts: CliTransportOptions;

  constructor(opts: CliTransportOptions = {}) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (!this.opts.repl) return;
    this.running = true;
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "polymath> " });
    this.rl.prompt();
    this.rl.on("line", (line) => void this.handleLine(line));
    this.rl.on("close", () => { this.running = false; });
    process.on("SIGINT", () => {
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      } else {
        this.stop();
      }
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.rl?.close();
  }

  async send(_sessionId: string, text: string): Promise<void> {
    process.stdout.write(text);
  }

  async runOneShot(task: string): Promise<string> {
    if (!this.opts.onInput) return "";
    this.abortController = new AbortController();
    try {
      const result = await this.opts.onInput(task, "cli-oneshot");
      return result;
    } finally {
      this.abortController = null;
    }
  }

  private async handleLine(raw: string): Promise<void> {
    const line = raw.trim();
    if (!line) { this.rl?.prompt(); return; }

    const slash = parseSlashCommand(line);
    if (slash) {
      this.handleSlashCommand(slash.command, slash.args);
      return;
    }

    if (this.opts.onInput) {
      this.abortController = new AbortController();
      try {
        const result = await this.opts.onInput(line, "cli-repl");
        if (result) process.stdout.write(result + "\n");
      } catch (e: any) {
        if (e?.name !== "AbortError") process.stderr.write(`Error: ${e?.message ?? e}\n`);
      } finally {
        this.abortController = null;
      }
    }
    this.rl?.prompt();
  }

  private handleSlashCommand(cmd: string, args: string): void {
    switch (cmd) {
      case "/help":
        for (const [k, v] of Object.entries(SLASH_COMMANDS)) process.stdout.write(`  ${k.padEnd(14)} ${v}\n`);
        break;
      case "/exit":
        this.stop();
        return;
      case "/skills": {
        const skills = this.opts.getSkills?.() ?? [];
        if (!skills.length) { process.stdout.write("No skills discovered\n"); break; }
        for (const s of skills) process.stdout.write(`  ${s.name.padEnd(20)} ${s.description}\n`);
        break;
      }
      case "/cron": {
        const jobs = this.opts.getCronJobs?.() ?? [];
        if (!jobs.length) { process.stdout.write("No cron jobs\n"); break; }
        for (const j of jobs) process.stdout.write(`  ${j.cron_expr.padEnd(16)} ${j.task ?? "(no task)"}\n`);
        break;
      }
      case "/channels": {
        const channels = this.opts.getChannels?.() ?? [];
        if (!channels.length) { process.stdout.write("No active transports\n"); break; }
        for (const ch of channels) process.stdout.write(`  ${ch.name.padEnd(14)} ${ch.status}\n`);
        break;
      }
      case "/reconnect":
        if (!args) { process.stdout.write("Usage: /reconnect <server-name>\n"); break; }
        if (this.opts.reconnectMcp) {
          this.opts.reconnectMcp(args).then(ok => {
            process.stdout.write(ok ? `Reconnected ${args}\n` : `Failed to reconnect ${args}\n`);
            this.rl?.prompt();
          });
          return;
        }
        process.stdout.write("/reconnect: not available\n");
        break;
      case "/tools":
      case "/history":
      case "/clear":
      case "/policy":
      case "/metrics":
        process.stdout.write(`${cmd}: not yet implemented\n`);
        break;
      default:
        process.stdout.write(`Unknown command: ${cmd}. Type /help for available commands.\n`);
    }
    this.rl?.prompt();
  }
}
