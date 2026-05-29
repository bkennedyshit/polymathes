import { Command } from "commander";
import { loadToken } from "./gateway/auth.js";

const program = new Command();
program
  .name("polymath")
  .version("0.1.1")
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
  .description("Run health checks against a running gateway")
  .action(async () => {
    const token = loadToken();
    if (!token) {
      console.error("✗ no auth token at ~/.polymath/auth.key — has the gateway ever booted?");
      process.exit(1);
    }
    let payload: any = null;
    try {
      const r = await fetch("http://127.0.0.1:18789/api/doctor", {
        headers: { authorization: "Bearer " + token },
        signal: AbortSignal.timeout(10_000),
      });
      payload = await r.json();
    } catch (e: any) {
      console.error(`✗ gateway not reachable at http://127.0.0.1:18789 — is it running?`);
      console.error(`  (${e?.message ?? e})`);
      process.exit(1);
    }

    const ok = (s: string) => s === "ok" || s === "connected";
    const symbol = (s: string) => (ok(s) ? "✓" : s === "unchecked" || s === "warn" ? "⚠" : "✗");
    let allOk = true;

    console.log("Polymath doctor");
    console.log("─".repeat(40));
    for (const check of payload.checks ?? []) {
      const sym = symbol(check.status);
      const latency = check.latency_ms != null ? ` (${check.latency_ms}ms)` : "";
      console.log(`${sym} ${check.label.padEnd(28)} ${check.status}${latency}`);
      if (check.detail) console.log(`    ${check.detail}`);
      if (!ok(check.status) && check.status !== "unchecked" && check.status !== "warn") allOk = false;
    }
    console.log("─".repeat(40));
    console.log(allOk ? "✓ all checks passed" : "✗ some checks failed");
    process.exit(allOk ? 0 : 1);
  });

// ------------------------- GPU lease --------------------------
const gpuCmd = program.command("gpu").description("Arbitrate local GPU access");

gpuCmd
  .command("claim <owner>")
  .description("Claim the GPU (evacuates Polymath's LLM). Releases on Ctrl+C or stdin EOF.")
  .option("--reason <text>", "short label for the claim")
  .option("--hold <minutes>", "auto-release after N minutes", (v) => parseInt(v, 10), 60)
  .action(async (owner: string, opts: { reason?: string; hold: number }) => {
    const token = loadToken();
    if (!token) { console.error("gateway not running or no token"); process.exit(1); }
    const res = await fetch("http://127.0.0.1:18789/api/gpu/claim", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ owner, reason: opts.reason, hold_minutes: opts.hold }),
    }).then((r) => r.json()).catch((e: any) => ({ ok: false, error: e.message }));
    if (!res.ok) { console.error("claim failed:", res.error); process.exit(1); }
    console.log(`GPU claimed for "${owner}". Lease token: ${res.token}`);
    console.log(`VRAM free: ${res.vram_free_mb} MB  ·  drained in ${res.waited_ms}ms`);
    console.log(`Press Ctrl+C to release.`);

    const release = async () => {
      await fetch("http://127.0.0.1:18789/api/gpu/release", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ token: res.token }),
      }).catch(() => {});
      console.log("\nGPU released.");
      process.exit(0);
    };
    process.on("SIGINT", release);
    process.on("SIGTERM", release);
    // Keep alive forever until signal.
    await new Promise(() => {});
  });

gpuCmd
  .command("status")
  .description("Show current GPU lease + VRAM state")
  .action(async () => {
    const token = loadToken();
    if (!token) { console.error("gateway not running"); process.exit(1); }
    const state = await fetch("http://127.0.0.1:18789/api/gpu/state", {
      headers: { authorization: "Bearer " + token },
    }).then((r) => r.json());
    console.log(JSON.stringify(state, null, 2));
  });

gpuCmd
  .command("release")
  .description("Force-release any current GPU lease (use if a claim was abandoned)")
  .action(async () => {
    const token = loadToken();
    if (!token) { console.error("gateway not running"); process.exit(1); }
    const res = await fetch("http://127.0.0.1:18789/api/gpu/release", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ token: "force" }),
    }).then((r) => r.json());
    console.log(res);
  });

gpuCmd
  .command("evacuate")
  .description("Immediately unload all Ollama models from VRAM")
  .action(async () => {
    const token = loadToken();
    if (!token) { console.error("gateway not running"); process.exit(1); }
    const res = await fetch("http://127.0.0.1:18789/api/gpu/evacuate", {
      method: "POST",
      headers: { authorization: "Bearer " + token },
    }).then((r) => r.json());
    console.log(res);
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

// ─── LLM auth + provider management ─────────────────────────────────
const llmCmd = program.command("llm").description("Manage LLM provider auth and models");
llmCmd
  .command("import-codex")
  .description("Import auth tokens from an existing Codex CLI install (~/.codex/auth.json)")
  .option("--yes", "skip the interactive confirmation prompt")
  .action(async (opts: { yes?: boolean }) => {
    try {
      const { importCodexAuth } = await import("./llm/codex/import_codex.js");
      const { account_id } = await importCodexAuth({ yes: opts.yes });
      console.log(`✓ Imported Codex auth (account: ${account_id}). Polymath will use it on next boot.`);
    } catch (e: any) {
      console.error(e?.message ?? String(e));
      process.exit(1);
    }
  });

llmCmd
  .command("login")
  .description("Sign in with ChatGPT in your default browser (uses your subscription, no API key needed)")
  .option("--provider <name>", "auth provider", "openai-codex")
  .action(async (opts: { provider: string }) => {
    if (opts.provider !== "openai-codex") {
      console.error(`Provider '${opts.provider}' has no browser login. Use --provider=openai-codex.`);
      process.exit(1);
    }
    try {
      const { loginCodex } = await import("./llm/codex/oauth_login.js");
      console.log("Opening browser for ChatGPT sign-in… (waiting up to 5 min)");
      const result = await loginCodex({
        onProgress: (m) => console.log(`  ${m}`),
      });
      console.log(`✓ Signed in as account ${result.account_id}.`);
      console.log("  Tokens saved to ~/.polymath/codex-auth.json");
    } catch (e: any) {
      console.error(`✗ ${e?.message ?? e}`);
      process.exit(1);
    }
  });

llmCmd
  .command("logout")
  .description("Wipe the local Codex auth tokens. Codex CLI's separate auth file is untouched.")
  .action(async () => {
    const { wipeAuth } = await import("./llm/codex/auth_store.js");
    await wipeAuth();
    console.log("✓ Codex auth wiped. Run `polymath llm login` to sign in again.");
  });

llmCmd
  .command("models")
  .description("List models available to the current Codex account (cached for 24h)")
  .option("--refresh", "force a re-fetch ignoring the cache")
  .option("--provider <name>", "auth provider", "openai-codex")
  .action(async (opts: { refresh?: boolean; provider: string }) => {
    if (opts.provider !== "openai-codex") {
      console.error(`Provider '${opts.provider}' uses /api/models — point your gateway query there instead.`);
      process.exit(1);
    }
    try {
      const { discoverModels } = await import("./llm/codex/models.js");
      const cache = await discoverModels({ version: "0.1.1", refresh: opts.refresh });
      const ageMs = Date.now() - new Date(cache.fetched_at).getTime();
      const ageMin = Math.round(ageMs / 60_000);
      console.log(`Codex models for account ${cache.account_id} (cache age ${ageMin}m)`);
      for (const m of cache.models) {
        const label = m.label ? `  (${m.label})` : "";
        console.log(`  ${m.id}${label}`);
      }
    } catch (e: any) {
      console.error(`✗ ${e?.message ?? e}`);
      process.exit(1);
    }
  });

llmCmd
  .command("status")
  .description("Show Codex auth freshness without making an API call")
  .action(async () => {
    const { loadAuth } = await import("./llm/codex/auth_store.js");
    const auth = await loadAuth();
    if (!auth) {
      console.log("(no codex auth — run `polymath llm import-codex` or `polymath llm login`)");
      return;
    }
    const ageMs = Date.now() - new Date(auth.last_refresh).getTime();
    const ageMin = Math.round(ageMs / 60_000);
    let state = "fresh";
    if (ageMs > 60 * 60 * 1000) state = "expired (refresh required)";
    else if (ageMs > 25 * 60 * 1000) state = "stale (will refresh on next call)";
    console.log(`account:      ${auth.tokens.account_id}`);
    console.log(`last refresh: ${auth.last_refresh}`);
    console.log(`state:        ${state} (${ageMin}m ago)`);
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

// ─── Workspace init + brands ────────────────────────────────────────
program
  .command("init [path]")
  .description("Initialize a Polymath content workspace at <path>")
  .option("--brands <csv>", "comma-separated brand names to pre-populate")
  .option("--force", "overwrite an existing non-empty directory")
  .option("--check", "report compliance instead of creating files")
  .action(async (path: string | undefined, opts: { brands?: string; force?: boolean; check?: boolean }) => {
    const { initWorkspace, checkWorkspace } = await import("./workspace/init.js");
    const target = path ?? process.cwd();

    if (opts.check) {
      const r = checkWorkspace(target);
      console.log(`Workspace check: ${target}`);
      if (r.marker) console.log(`  initialized:  ${r.marker.initialized_at}`);
      if (r.marker) console.log(`  brands:       ${r.marker.brands.join(", ") || "(none)"}`);
      if (r.marker) console.log(`  template ver: ${r.marker.template_version}`);
      if (r.missing.length) console.log(`  missing:      ${r.missing.join(", ")}`);
      for (const note of r.notes) console.log(`  note: ${note}`);
      console.log(r.ok ? "✓ workspace looks good" : "✗ workspace has issues");
      process.exit(r.ok ? 0 : 1);
    }

    const brands = opts.brands ? opts.brands.split(",").map((b) => b.trim()).filter(Boolean) : [];

    // Interactive prompt when no --brands flag and we're attached to a TTY.
    // Skipped automatically in non-interactive contexts (CI, scripts).
    let finalBrands = brands;
    if (!finalBrands.length && process.stdin.isTTY) {
      const readline = await import("node:readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer: string = await new Promise((resolve) => {
        rl.question("What brands will you create content for? (comma-separated, or blank to skip): ", (a) => {
          rl.close(); resolve(a);
        });
      });
      finalBrands = answer.split(",").map((b) => b.trim()).filter(Boolean);
    }

    const result = initWorkspace(target, { brands: finalBrands, force: opts.force });
    if (!result.ok) {
      console.error(`init failed: ${result.error}`);
      process.exit(1);
    }
    console.log(`✓ Polymath workspace initialized at ${result.path}`);
    if (finalBrands.length > 0) {
      console.log(`✓ Brands materialized: ${finalBrands.join(", ")}`);
      // Persist into the global brand registry too.
      const { addBrand } = await import("./workspace/init.js");
      for (const b of finalBrands) addBrand(b);
    } else {
      console.log(`  Add brands later: polymath brands add <name>`);
    }
    console.log(`  Catalog files:   polymath media seed ${result.path}`);
  });

const brandsCmd = program.command("brands").description("Manage your content brand registry");
brandsCmd
  .command("list")
  .description("List configured brands")
  .action(async () => {
    const { loadBrands } = await import("./workspace/init.js");
    const brands = loadBrands();
    if (!brands.length) {
      console.log("(no brands yet — add one with: polymath brands add <name>)");
      return;
    }
    for (const b of brands) console.log(b);
  });
brandsCmd
  .command("add <name>")
  .description("Add a brand. Materializes input/<name>/ and content/<name>/ if --workspace is given.")
  .option("--workspace <path>", "workspace path to materialize subdirectories in")
  .action(async (name: string, opts: { workspace?: string }) => {
    const { addBrand } = await import("./workspace/init.js");
    const result = addBrand(name, opts.workspace);
    if (!result.ok) { console.error(`✗ ${result.error}`); process.exit(1); }
    console.log(`✓ Added brand: ${result.brand}`);
    if (result.created?.length) {
      console.log(`  Materialized ${result.created.length} files under ${opts.workspace}`);
    }
  });
brandsCmd
  .command("remove <name>")
  .description("Remove a brand from the registry (does not delete files)")
  .action(async (name: string) => {
    const { removeBrand } = await import("./workspace/init.js");
    const result = removeBrand(name);
    console.log(`✓ Removed. ${result.brands.length} brands remain.`);
  });

// ─── Media seeding ──────────────────────────────────────────────────
const mediaCmd = program.command("media").description("Catalog and inspect media files");
mediaCmd
  .command("seed <path>")
  .description("Walk a directory tree, classify each file, and register it in the catalog")
  .option("--since <iso>", "only seed files modified after this ISO timestamp")
  .option("--max-file-mb <n>", "skip files larger than N MB", (v) => parseInt(v, 10), 2048)
  .option("--max-video-minutes <n>", "warn on videos longer than N minutes", (v) => parseInt(v, 10), 10)
  .option("--force-large", "bypass size/duration guardrails")
  .option("--dry-run", "scan and print what would happen, but don't write")
  .action(async (path: string, opts: { since?: string; maxFileMb: number; maxVideoMinutes: number; forceLarge?: boolean; dryRun?: boolean }) => {
    const { seedMedia } = await import("./workspace/seed_media.js");
    const { openDb } = await import("./db/open.js");
    const { runMigrations } = await import("./db/migrate.js");
    const { MediaEpisodic } = await import("./memory/media_episodic.js");

    const db = openDb();
    runMigrations(db);
    const ep = new MediaEpisodic(db);

    // Wire text embedding into semantic memory so notes/blogs become
    // RAG-able. Best-effort: needs a local Ollama embedder. If none is
    // reachable we skip embedding (the files are still cataloged).
    let textEmbedder: { embed: (t: string) => Promise<Float32Array | null> } | null = null;
    let semantic: any = null;
    if (!opts.dryRun) {
      try {
        const { loadConfig } = await import("./config/load.js");
        const cfg = loadConfig();
        const { OllamaEmbedder } = await import("./memory/embed.js");
        const { SemanticMemory } = await import("./memory/semantic.js");
        const fleet = (cfg.memory.embedder_base_url && cfg.memory.embedder_base_url.trim())
          ? cfg.memory.embedder_base_url
          : "http://localhost:11434/v1";
        const api = fleet.replace(/\/v1\/?$/, "");
        // Probe Ollama; only enable embedding if it's actually up.
        const probe = await fetch(api + "/api/tags", { signal: AbortSignal.timeout(800) }).then((r) => r.ok).catch(() => false);
        if (probe) {
          textEmbedder = new OllamaEmbedder({ baseUrl: api, model: cfg.memory.embedding_model || "nomic-embed-text" });
          semantic = new SemanticMemory(db);
        }
      } catch { /* embedding optional */ }
    }

    // Split a text doc into ~200-word chunks for embedding.
    const chunkText = (content: string, srcPath: string): string[] => {
      const words = content.split(/\s+/).filter(Boolean);
      const out: string[] = [];
      const SIZE = 200, OVERLAP = 20;
      for (let i = 0; i < words.length; i += SIZE - OVERLAP) {
        const slice = words.slice(i, i + SIZE).join(" ");
        if (slice.trim()) out.push(`[${srcPath.split(/[\\/]/).pop()}] ${slice}`.slice(0, 4000));
      }
      return out.length ? out : [];
    };

    let textChunksEmbedded = 0;
    let lastReportedAt = Date.now();
    const result = await seedMedia(path, ep, {
      since: opts.since,
      maxFileMb: opts.maxFileMb,
      maxVideoMinutes: opts.maxVideoMinutes,
      forceLarge: opts.forceLarge,
      dryRun: opts.dryRun,
      onText: textEmbedder && semantic ? async ({ path: p, content }) => {
        for (const chunk of chunkText(content, p)) {
          try {
            const vec = await textEmbedder!.embed(chunk);
            if (vec) { semantic.store(chunk, vec, `seed:${p}`); textChunksEmbedded++; }
          } catch { /* skip bad chunk */ }
        }
      } : undefined,
      onProgress: (ev) => {
        if (ev.type === "register" && Date.now() - lastReportedAt > 1000) {
          process.stdout.write(`  registered: ${ev.path}\n`);
          lastReportedAt = Date.now();
        }
      },
    });
    db.close();

    console.log("");
    console.log(`Seed complete${result.dry_run ? " (dry-run — no writes)" : ""}.`);
    console.log(`  total scanned: ${result.total_files}`);
    console.log(`  registered:    ${result.registered}`);
    console.log(`  skipped:       ${result.skipped}`);
    if (textChunksEmbedded > 0) {
      console.log(`  text embedded: ${textChunksEmbedded} chunks → semantic memory`);
    }
    console.log(`  duration:      ${(result.duration_ms / 1000).toFixed(1)}s`);
    console.log("");
    console.log("by brand:");
    for (const [brand, n] of Object.entries(result.by_brand).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${brand.padEnd(20)} ${n}`);
    }
    console.log("");
    console.log("by category:");
    for (const [cat, n] of Object.entries(result.by_category).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cat.padEnd(20)} ${n}`);
    }
    if (result.warnings.length) {
      console.log("");
      console.log(`warnings (${result.warnings.length}):`);
      for (const w of result.warnings.slice(0, 20)) console.log(`  ${w}`);
      if (result.warnings.length > 20) console.log(`  ... +${result.warnings.length - 20} more`);
    }
  });
mediaCmd
  .command("stats")
  .description("Print catalog totals + brand/category breakdown")
  .action(async () => {
    const { openDb } = await import("./db/open.js");
    const { runMigrations } = await import("./db/migrate.js");
    const { MediaEpisodic } = await import("./memory/media_episodic.js");
    const db = openDb();
    runMigrations(db);
    const stats = new MediaEpisodic(db).stats();
    db.close();
    console.log(`Catalog: ${stats.total} items`);
    console.log("");
    console.log("by brand:");
    for (const [brand, n] of Object.entries(stats.by_brand).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${brand.padEnd(20)} ${n}`);
    }
    console.log("");
    console.log("by category:");
    for (const [cat, n] of Object.entries(stats.by_category).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cat.padEnd(20)} ${n}`);
    }
  });

mediaCmd
  .command("retag <id>")
  .description("Manually correct a media item's brand/category. Persists in the catalog and a brand-overrides file so future seeds keep the fix.")
  .option("--brand <name>", "set brand")
  .option("--category <name>", "set category")
  .option("--intent <name>", "set intent")
  .action(async (id: string, opts: { brand?: string; category?: string; intent?: string }) => {
    if (!opts.brand && !opts.category && !opts.intent) {
      console.error("Pass at least one of --brand / --category / --intent");
      process.exit(1);
    }
    const { openDb } = await import("./db/open.js");
    const { runMigrations } = await import("./db/migrate.js");
    const { MediaEpisodic } = await import("./memory/media_episodic.js");
    const db = openDb();
    runMigrations(db);
    const ep = new MediaEpisodic(db);
    const existing = ep.getById(id);
    if (!existing) {
      console.error(`No media item with id ${id}`);
      db.close();
      process.exit(1);
    }
    ep.upsert({
      path: existing.path,
      brand: opts.brand ?? existing.brand,
      category: opts.category ?? existing.category,
      intent: opts.intent ?? existing.intent,
    });
    db.close();

    // Persist override so re-seeding doesn't undo the change.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const overridePath = path.join(os.homedir(), ".polymath", "brand-overrides.json");
    let overrides: Record<string, any> = {};
    if (fs.existsSync(overridePath)) {
      try { overrides = JSON.parse(fs.readFileSync(overridePath, "utf-8")); }
      catch { overrides = {}; }
    }
    overrides[existing.path] = {
      brand: opts.brand ?? existing.brand,
      category: opts.category ?? existing.category,
      intent: opts.intent ?? existing.intent,
    };
    fs.mkdirSync(path.dirname(overridePath), { recursive: true });
    fs.writeFileSync(overridePath, JSON.stringify(overrides, null, 2), "utf-8");
    console.log(`✓ Retagged ${id}`);
    console.log(`  override saved to ${overridePath}`);
  });

mediaCmd
  .command("vision-index <path>")
  .description("Run the C++ media-memory CLIP indexer on a directory tree. Builds the visual-similarity index used by media.vision_search.")
  .option("--recursive", "walk subdirectories (default true)", true)
  .option("--force-large", "include videos > 10 minutes")
  .action(async (target: string, opts: { recursive?: boolean; forceLarge?: boolean }) => {
    const token = loadToken();
    if (!token) { console.error("gateway not running or no token"); process.exit(1); }
    const args = { path: target, recursive: opts.recursive !== false, force_large: !!opts.forceLarge };
    process.stdout.write(`Indexing ${target} via media-memory MCP server… `);
    try {
      const r = await fetch("http://127.0.0.1:18789/api/actions/invoke", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ tool: "media-memory.index", args }),
        signal: AbortSignal.timeout(60 * 60 * 1000), // 1h cap — vision indexing is slow
      });
      const body = await r.json();
      if (!body.ok) { console.log("\n✗ index failed:", body.error); process.exit(1); }
      console.log("done.");
      console.log(JSON.stringify(body.result, null, 2));
    } catch (e: any) {
      console.error("\n✗", e?.message ?? e);
      process.exit(1);
    }
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
