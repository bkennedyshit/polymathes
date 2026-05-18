// codex-smoke.mjs — manual smoke test for the Codex auth + adapter
//
// Hits the REAL endpoints with the REAL token store. Does NOT modify
// polymath.json. Run with:
//   node scripts/codex-smoke.mjs
//
// Steps:
//   1. ensureFreshToken() — exercises refresh against auth.openai.com
//      (your token is 8 days old so refresh WILL fire).
//   2. /v1/models — discovery against chatgpt.com/backend-api/codex.
//   3. POST /responses with one trivial message — full adapter round-trip.
//
// Reports per-step success/failure, latencies, and the streaming chunk
// count. Exits 0 on full success, non-zero with a diagnostic on
// failure.

import { performance } from "node:perf_hooks";
import { ensureFreshToken } from "../dist/llm/codex/auth_refresh.js";
import { OpenAiCodexAdapter } from "../dist/llm/codex/responses_adapter.js";
import { loadAuth } from "../dist/llm/codex/auth_store.js";

const RESPONSES_BASE = "https://chatgpt.com/backend-api/codex";

function divider(label) {
  console.log("");
  console.log("─".repeat(48));
  console.log(label);
  console.log("─".repeat(48));
}

function ms(t0) {
  return `${(performance.now() - t0).toFixed(0)}ms`;
}

async function main() {
  divider("Step 0 — load auth store");
  const auth = await loadAuth();
  if (!auth) {
    console.error("✗ no codex-auth.json found — run `polymath llm import-codex` first");
    process.exit(1);
  }
  console.log(`✓ store loaded`);
  console.log(`  account_id:   ${auth.tokens.account_id}`);
  console.log(`  last_refresh: ${auth.last_refresh}`);
  const ageMin = (Date.now() - new Date(auth.last_refresh).getTime()) / 60000;
  console.log(`  age:          ${ageMin.toFixed(1)} min (refresh window 25m)`);

  divider("Step 1 — ensureFreshToken (refresh fires if > 25 min)");
  let tokens;
  let t0 = performance.now();
  try {
    tokens = await ensureFreshToken();
    console.log(`✓ refreshed in ${ms(t0)}`);
    console.log(`  access_token len: ${tokens.access_token.length}`);
    console.log(`  account_id:       ${tokens.account_id}`);
  } catch (e) {
    console.error(`✗ refresh failed: ${e?.message ?? e}`);
    process.exit(1);
  }

  divider("Step 2 — GET /v1/models (discover available models)");
  t0 = performance.now();
  try {
    const r = await fetch(`${RESPONSES_BASE}/v1/models`, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "OpenAI-Account-Id": tokens.account_id,
        "User-Agent": "Polymath/0.1.1-smoke",
      },
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error(`✗ /v1/models HTTP ${r.status} (${ms(t0)})`);
      console.error(`  body: ${detail.slice(0, 400)}`);
      process.exit(1);
    }
    const j = await r.json();
    const ids = (j?.data ?? []).map((m) => m.id);
    console.log(`✓ discovered ${ids.length} models in ${ms(t0)}`);
    for (const id of ids.slice(0, 12)) console.log(`    ${id}`);
    if (ids.length > 12) console.log(`    ... +${ids.length - 12} more`);
    // Pick the first model the account exposes for the next step.
    if (!ids.length) {
      console.error("✗ no models on this account — can't smoke-test inference");
      process.exit(1);
    }
    globalThis.__SMOKE_MODEL = ids[0];
  } catch (e) {
    console.error(`✗ /v1/models fetch failed: ${e?.message ?? e}`);
    process.exit(1);
  }

  divider(`Step 3 — POST /responses with model=${globalThis.__SMOKE_MODEL}`);
  t0 = performance.now();
  try {
    const adapter = new OpenAiCodexAdapter({
      version: "0.1.1-smoke",
      model: globalThis.__SMOKE_MODEL,
      streaming: true,
    });
    const messages = [
      { role: "user", content: "reply with exactly one word: pong" },
    ];
    let chunkCount = 0;
    let content = "";
    let firstChunkAt = null;
    let usage = null;
    let finishReason = null;
    for await (const delta of adapter.complete(messages, [], { stream: true })) {
      chunkCount++;
      if (firstChunkAt === null) firstChunkAt = performance.now();
      if (delta.content) content += delta.content;
      if (delta.usage) usage = delta.usage;
      if (delta.finish_reason) finishReason = delta.finish_reason;
    }
    const ttfb = firstChunkAt ? (firstChunkAt - t0).toFixed(0) : "n/a";
    console.log(`✓ stream completed in ${ms(t0)} (TTFB ${ttfb}ms, ${chunkCount} chunks)`);
    console.log(`  finish_reason: ${finishReason ?? "(none)"}`);
    console.log(`  account_id:    ${adapter.getAccountId()}`);
    console.log(`  usage:         ${usage ? JSON.stringify(usage) : "(none)"}`);
    console.log(`  content:       ${JSON.stringify(content)}`);
    if (!content.trim()) {
      console.error("✗ empty content — adapter parsed the stream wrong");
      process.exit(1);
    }
  } catch (e) {
    console.error(`✗ /responses call failed: ${e?.message ?? e}`);
    if (e?.stack) console.error(e.stack);
    process.exit(1);
  }

  divider("ALL GREEN");
  console.log("Codex auth + adapter is wired end-to-end against your live");
  console.log("ChatGPT subscription. Safe to flip provider:openai-codex in");
  console.log("polymath.json.");
}

main().catch((e) => {
  console.error(`✗ unexpected: ${e?.message ?? e}`);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
