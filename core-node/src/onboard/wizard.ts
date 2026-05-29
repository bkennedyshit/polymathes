import * as readline from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir, platform } from "node:os";

function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : p;
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((res) => rl.question(question, res));
}

async function testLlm(provider: string, apiKey: string): Promise<boolean> {
  try {
    const url = provider === "anthropic"
      ? "https://api.anthropic.com/v1/messages"
      : "https://api.openai.com/v1/chat/completions";

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let body: string;

    if (provider === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      body = JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
      body = JSON.stringify({ model: "gpt-4o-mini", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
    }

    const res = await fetch(url, { method: "POST", headers, body });
    return res.ok;
  } catch { return false; }
}

async function testTelegram(token: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    return res.ok;
  } catch { return false; }
}

export interface OnboardOpts {
  installDaemon?: boolean;
  rl?: readline.Interface; // injectable for testing
}

export async function runOnboard(opts: OnboardOpts = {}): Promise<void> {
  const rl = opts.rl ?? readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("\n🔮 Welcome to Polymath setup\n");

  // LLM provider
  const provider = (await ask(rl, "LLM provider (openai/anthropic/local) [openai]: ")).trim() || "openai";
  let apiKey = "";
  if (provider !== "local") {
    apiKey = (await ask(rl, `${provider} API key: `)).trim();
    if (apiKey) {
      process.stdout.write("  Testing connection... ");
      const ok = await testLlm(provider, apiKey);
      console.log(ok ? "✓" : "✗ (key may be invalid, continuing)");
    }
  }

  // Telegram
  const tgToken = (await ask(rl, "Telegram bot token (optional, press Enter to skip): ")).trim();
  let tgEnabled = false;
  if (tgToken) {
    process.stdout.write("  Testing Telegram... ");
    const ok = await testTelegram(tgToken);
    console.log(ok ? "✓" : "✗ (token may be invalid, continuing)");
    tgEnabled = ok;
  }

  // Home dir
  const homeDir = (await ask(rl, "Home directory [~/.polymath]: ")).trim() || "~/.polymath";

  // Write config
  const config = {
    runtime: { home_dir: homeDir, port: 18789, log_level: "info" },
    llm: { provider, model: provider === "anthropic" ? "claude-sonnet-4-20250514" : provider === "local" || provider === "ollama" ? "llama3:8b" : "gpt-4o", api_key: apiKey, base_url: (provider === "local" || provider === "ollama") ? "http://localhost:11434/v1" : undefined, streaming: true, context_window: 128000, temperature: 0.7 },
    orchestrator: { max_iterations: 25, max_token_budget: 200000, max_subagent_depth: 3 },
    sandbox: { default_mode: "host", tool_overrides: {} },
    channels: {
      telegram: { token: tgToken, enabled: tgEnabled },
      discord: { token: "", enabled: false },
      signal: { enabled: false },
      email: { imap: "", smtp: "", enabled: false },
      webchat: { enabled: true },
    },
    mcp_servers: [],
    agents: [],
    memory: { consolidation_model: "gpt-4o-mini", embedding_model: "nomic-embed-text", recall_weights: { semantic: 0.5, episodic: 0.3, recency: 0.2 } },
    cron: { enabled: true },
  };

  const dir = resolve(expandHome(homeDir));
  mkdirSync(dir, { recursive: true });
  const configPath = resolve(dir, "polymath.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  console.log(`\n  Config written to ${configPath}`);

  // Daemon install
  if (opts.installDaemon) {
    if (platform() === "linux") {
      const unit = `[Unit]\nDescription=Polymath Agent Runtime\nAfter=network.target\n\n[Service]\nExecStart=polymath\nRestart=on-failure\nEnvironment=HOME=${homedir()}\n\n[Install]\nWantedBy=default.target\n`;
      const unitPath = resolve(homedir(), ".config/systemd/user/polymath.service");
      mkdirSync(resolve(unitPath, ".."), { recursive: true });
      writeFileSync(unitPath, unit);
      console.log(`  Systemd unit written to ${unitPath}`);
      console.log("  Enable with: systemctl --user enable --now polymath");
    } else {
      const xml = `<?xml version="1.0" encoding="UTF-16"?>\n<Task><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Actions><Exec><Command>polymath</Command></Exec></Actions></Task>`;
      const xmlPath = resolve(dir, "polymath-task.xml");
      writeFileSync(xmlPath, xml);
      console.log(`  Task Scheduler XML written to ${xmlPath}`);
      console.log("  Import with: schtasks /create /tn Polymath /xml " + xmlPath);
    }
  }

  console.log("\n  Setup complete. Run: polymath\n");
  if (!opts.rl) rl.close();
}

export { expandHome as _expandHome };
