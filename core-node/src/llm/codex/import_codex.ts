/**
 * Import Codex CLI auth into Polymath's token store.
 *
 * Reads `<CODEX_HOME>/auth.json` (defaulting to `~/.codex/auth.json`),
 * validates that it's in `chatgpt` mode, and copies the relevant fields
 * to Polymath's auth store via `saveAuth()` from T1. The source file is
 * **never** modified — Codex CLI keeps working alongside Polymath, and
 * both can refresh the same `refresh_token` independently.
 *
 * See `.kiro/specs/polymath-codex-auth/requirements.md` (R1.2) and
 * `design.md` (R1.2 — Import from existing Codex install).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";

import { saveAuth } from "./auth_store.js";
import type {
  CodexAuthStored,
  CodexTokens,
} from "./responses_protocol.js";

interface ImportCodexOptions {
  /** Skip the interactive confirmation prompt. */
  yes?: boolean;
}

interface ImportCodexResult {
  account_id: string;
}

/**
 * Resolve the Codex home directory the same way the Codex CLI does:
 * honour `CODEX_HOME` if set, otherwise fall back to `~/.codex`.
 */
function getCodexAuthPath(): string {
  const override = process.env.CODEX_HOME;
  const codexHome = override && override.trim() ? override : join(homedir(), ".codex");
  return join(codexHome, "auth.json");
}

/**
 * Read a single line from stdin. Returns the trimmed input. Used for
 * the interactive confirmation prompt — kept as a small helper so it's
 * trivial to mock in tests (we just pass `{ yes: true }` to bypass it).
 */
function readSingleLine(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.once("line", (line) => {
      rl.close();
      resolve(line);
    });
  });
}

/**
 * Validate that the parsed Codex auth file has all the fields we need
 * before we copy them into Polymath's store. Throws a clear,
 * user-actionable error if any required field is missing.
 */
function extractTokens(parsed: any): CodexTokens {
  const tokens = parsed?.tokens;
  const access_token = tokens?.access_token;
  const refresh_token = tokens?.refresh_token;
  const account_id = tokens?.account_id;
  if (
    typeof access_token !== "string" || !access_token ||
    typeof refresh_token !== "string" || !refresh_token ||
    typeof account_id !== "string" || !account_id
  ) {
    throw new Error(
      "Codex auth file is missing required fields (tokens.access_token / refresh_token / account_id)."
    );
  }
  return {
    access_token,
    // id_token is not strictly required for the Polymath flow but Codex
    // always writes one. Default to empty string when absent so the
    // typed shape is satisfied.
    id_token: typeof tokens?.id_token === "string" ? tokens.id_token : "",
    refresh_token,
    account_id,
  };
}

/**
 * Read `<CODEX_HOME>/auth.json`, validate it, optionally prompt the
 * user, and persist the tokens via `saveAuth()`. Returns the imported
 * `account_id` so the CLI can echo it back.
 *
 * Errors are thrown — callers (the CLI) are responsible for printing
 * to stderr and exiting non-zero.
 */
export async function importCodexAuth(
  opts: ImportCodexOptions = {}
): Promise<ImportCodexResult> {
  const sourcePath = getCodexAuthPath();

  if (!existsSync(sourcePath)) {
    throw new Error(
      `No Codex auth file at ${sourcePath}. Run \`codex login\` first or use \`polymath llm login\` instead.`
    );
  }

  let parsed: any;
  try {
    const raw = readFileSync(sourcePath, "utf-8");
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read Codex auth file at ${sourcePath}: ${detail}`);
  }

  const authMode = parsed?.auth_mode;
  if (authMode !== "chatgpt") {
    throw new Error(
      `Codex auth at ${sourcePath} is in '${authMode}' mode, expected 'chatgpt'. This import is for ChatGPT subscription auth only.`
    );
  }

  const tokens = extractTokens(parsed);

  if (opts.yes !== true) {
    process.stderr.write(
      `Import auth tokens from ${sourcePath} to Polymath? Codex CLI will continue working alongside Polymath. [y/N] `
    );
    const answer = (await readSingleLine()).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      throw new Error("Import cancelled.");
    }
  }

  const lastRefresh =
    typeof parsed?.last_refresh === "string" && parsed.last_refresh
      ? parsed.last_refresh
      : new Date().toISOString();

  const stored: CodexAuthStored = {
    auth_mode: "chatgpt",
    tokens,
    last_refresh: lastRefresh,
  };

  await saveAuth(stored);

  return { account_id: tokens.account_id };
}
