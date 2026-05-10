import { Command } from "commander";
import { loadToken } from "./gateway/auth.js";

const program = new Command();
program
  .name("polymath")
  .version("0.1.0")
  .description("Polymath agent runtime")
  .option("--config <path>", "path to config file")
  .option("--model <model>", "override LLM model")
  .option("--verbose", "verbose output")
  .option("--max-iterations <n>", "max orchestrator iterations", parseInt)
  .option("--log-level <level>", "log level (trace|debug|info|warn|error)");

program
  .command("agent [task...]")
  .description("Run agent in one-shot or REPL mode")
  .option("--repl", "start interactive REPL")
  .action(async (task: string[], opts: { repl?: boolean }) => {
    const { boot, startGateway } = await import("./main.js");
    const parentOpts = program.opts();
    let ctx;
    try {
      ctx = await boot({ config: parentOpts.config, model: parentOpts.model, verbose: parentOpts.verbose, logLevel: parentOpts.logLevel, maxIterations: parentOpts.maxIterations });
    } catch (e: any) {
      console.error(`Config error: ${e.message}`);
      process.exit(2);
    }

    try {
      if (opts.repl) {
        startGateway(ctx);
        const { CliTransport } = await import("./transports/cli.js");
        const transport = new CliTransport({ repl: true, verbose: parentOpts.verbose, onInput: async (text) => ctx.runTask(text) });
        ctx.transports.push(transport);
        await transport.start();
      } else if (task.length > 0) {
        const result = await ctx.runTask(task.join(" "));
        process.stdout.write(result + "\n");
        await ctx.shutdown();
        process.exit(0);
      } else if (!process.stdin.isTTY) {
        // Piped stdin
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const input = Buffer.concat(chunks).toString("utf-8").trim();
        if (!input) { await ctx.shutdown(); process.exit(1); }
        const result = await ctx.runTask(input);
        process.stdout.write(result + "\n");
        await ctx.shutdown();
        process.exit(0);
      } else {
        console.error("Provide a task or use --repl");
        await ctx.shutdown();
        process.exit(1);
      }
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      await ctx.shutdown();
      process.exit(1);
    }
  });

program
  .command("show-token")
  .description("Print the gateway auth token")
  .action(() => {
    const token = loadToken();
    if (token) process.stdout.write(token + "\n");
    else { console.error("No auth token found. Run the gateway first."); process.exit(1); }
  });

program
  .command("doctor")
  .description("Run health checks")
  .action(() => {
    console.log("polymath doctor: all checks passed (stub)");
  });

const pairCmd = program.command("pair").description("Manage pairing codes");
pairCmd
  .command("approve <code>")
  .description("Approve a pending pairing code")
  .action(async (code: string) => {
    const { openDb } = await import("./db/open.js");
    const { runMigrations } = await import("./db/migrate.js");
    const { PairingManager } = await import("./security/pairing.js");
    const db = openDb();
    runMigrations(db);
    const pm = new PairingManager(db);
    pm.approvePairing(code);
    console.log(`Approved pairing: ${code}`);
    db.close();
  });

pairCmd
  .command("list")
  .description("List pending pairing codes")
  .action(async () => {
    const { openDb } = await import("./db/open.js");
    const { runMigrations } = await import("./db/migrate.js");
    const { PairingManager } = await import("./security/pairing.js");
    const db = openDb();
    runMigrations(db);
    const pm = new PairingManager(db);
    const pending = pm.listPending();
    if (!pending.length) { console.log("No pending pairings"); db.close(); return; }
    for (const p of pending) console.log(`  ${p.code}  ${p.channel}  ${p.sender_id}  ${p.created_at}`);
    db.close();
  });

const mcpCmd = program.command("mcp").description("MCP operations");
mcpCmd
  .command("serve")
  .description("Start MCP server on stdio")
  .action(async () => {
    const { ToolRegistry } = await import("./tools/registry.js");
    const { discoverTools } = await import("./tools/discover.js");
    const { McpServer } = await import("./tools/mcp/server.js");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dir = dirname(fileURLToPath(import.meta.url));
    const registry = new ToolRegistry();
    await discoverTools(registry, join(__dir, "tools", "builtin"));
    const server = new McpServer(registry);
    await server.startStdio();
  });

const skillsCmd = program.command("skills").description("Manage skills from agentskills.io");
skillsCmd
  .command("install <name>")
  .description("Install a skill from agentskills.io")
  .action(async (name: string) => {
    const { installSkill } = await import("./skills/hub.js");
    const result = await installSkill(name, process.cwd());
    console.log(result);
  });
skillsCmd
  .command("search <query>")
  .description("Search skills on agentskills.io")
  .action(async (query: string) => {
    const { searchSkills } = await import("./skills/hub.js");
    const result = await searchSkills(query);
    if (typeof result === "string") { console.error(result); process.exit(1); }
    for (const s of result) console.log(`${s.name} — ${s.description}`);
  });

// Default action (no subcommand) → start gateway or read piped stdin
program.action(async () => {
  const { boot, startGateway } = await import("./main.js");
  const opts = program.opts();
  let ctx;
  try {
    ctx = await boot({ config: opts.config, model: opts.model, verbose: opts.verbose, logLevel: opts.logLevel, maxIterations: opts.maxIterations });
  } catch (e: any) {
    console.error(`Config error: ${e.message}`);
    process.exit(2);
  }

  if (!process.stdin.isTTY) {
    // Piped stdin without subcommand
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = Buffer.concat(chunks).toString("utf-8").trim();
    if (!input) { await ctx.shutdown(); process.exit(1); }
    const result = await ctx.runTask(input);
    process.stdout.write(result + "\n");
    await ctx.shutdown();
    process.exit(0);
  }

  // TTY: start gateway + REPL
  startGateway(ctx);
  const { CliTransport } = await import("./transports/cli.js");
  const transport = new CliTransport({ repl: true, verbose: opts.verbose, onInput: async (text) => ctx.runTask(text) });
  ctx.transports.push(transport);
  await transport.start();
});

program.parse();
