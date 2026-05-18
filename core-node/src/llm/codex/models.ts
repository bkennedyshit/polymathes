/**
 * Codex model discovery + cache.
 *
 * The Codex Responses backend exposes a `/v1/models` listing under the
 * same base URL it serves inference from. We hit it once per 24h, cache
 * the result at `<polymath_home>/codex-models.json`, and expose
 * `discoverModels({ refresh })` so the CLI / UI can force a re-fetch.
 *
 * This avoids round-tripping a model list every time the Settings tab
 * renders, and gracefully degrades to the cache when the user is offline.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ensureFreshToken } from "./auth_refresh.js";
import { CodexAuthExpired } from "./responses_protocol.js";

const CACHE_FILE = "codex-models.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MODELS_URL = "https://chatgpt.com/backend-api/codex/v1/models";

export interface CodexModelInfo {
  /** Stable model identifier passed to the Responses API. */
  id: string;
  /** Optional human label some catalog responses include. */
  label?: string;
  /** Object type echoed by the upstream — usually `"model"`. */
  object?: string;
}

export interface CodexModelsCache {
  fetched_at: string;
  models: CodexModelInfo[];
  account_id: string;
}

export interface DiscoverOptions {
  /** Polymath version surfaced in the User-Agent — same source as the adapter. */
  version: string;
  /** Force a re-fetch even if the cache is fresh. */
  refresh?: boolean;
}

function getPolymathHome(): string {
  const override = process.env.POLYMATH_HOME;
  if (override && override.trim()) return override;
  return join(homedir(), ".polymath");
}

function getCachePath(): string {
  return join(getPolymathHome(), CACHE_FILE);
}

/** Read the on-disk cache; returns `null` if missing or corrupt. */
export function loadModelsCache(): CodexModelsCache | null {
  const path = getCachePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as CodexModelsCache;
  } catch {
    return null;
  }
}

function saveModelsCache(cache: CodexModelsCache): void {
  const dir = getPolymathHome();
  mkdirSync(dir, { recursive: true });
  writeFileSync(getCachePath(), JSON.stringify(cache, null, 2), "utf-8");
}

function isFresh(cache: CodexModelsCache | null): boolean {
  if (!cache) return false;
  const age = Date.now() - new Date(cache.fetched_at).getTime();
  return age < CACHE_TTL_MS;
}

/**
 * Return the catalog of models the user's plan can call. Honors a 24h
 * cache so booting Polymath doesn't always cost a round-trip.
 *
 * Throws `CodexAuthExpired` if the call fails with 401 — the caller
 * (CLI / gateway) can then prompt the user to re-login.
 */
export async function discoverModels(opts: DiscoverOptions): Promise<CodexModelsCache> {
  const cached = loadModelsCache();
  if (!opts.refresh && isFresh(cached)) {
    return cached as CodexModelsCache;
  }

  let tokens;
  try {
    tokens = await ensureFreshToken();
  } catch (e) {
    // If we can't refresh and we have a cache, return it stale rather
    // than throw. The user gets *something* in the UI even if their
    // session is borked.
    if (cached) return cached;
    throw e;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.access_token}`,
    "OpenAI-Account-Id": tokens.account_id,
    "User-Agent": `Polymath/${opts.version}`,
    Accept: "application/json",
  };

  const res = await fetch(MODELS_URL, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 401) {
    throw new CodexAuthExpired("Codex models endpoint rejected token. Re-login with `polymath llm login`.");
  }
  if (!res.ok) {
    // Fall back to cache rather than blow up the boot path.
    if (cached) return cached;
    throw new Error(`Codex models request failed: HTTP ${res.status}`);
  }

  const body = (await res.json()) as { data?: any[]; models?: any[] };
  const raw = body.data ?? body.models ?? [];
  const models: CodexModelInfo[] = raw.map((m: any) => ({
    id: typeof m === "string" ? m : (m.id ?? m.name ?? ""),
    label: m.display_name ?? m.label,
    object: m.object,
  })).filter((m) => m.id);

  const cache: CodexModelsCache = {
    fetched_at: new Date().toISOString(),
    models,
    account_id: tokens.account_id,
  };
  saveModelsCache(cache);
  return cache;
}
