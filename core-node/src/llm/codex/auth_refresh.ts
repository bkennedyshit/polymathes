/**
 * Token refresh logic for the Codex (ChatGPT subscription) auth flow.
 *
 * Codex access tokens are short-lived (~30 min). The adapter does two
 * things to stay ahead of expiry:
 *
 *   1. Calls `ensureFreshToken()` before every request. If the stored
 *      `last_refresh` is older than 25 minutes we pre-emptively refresh
 *      so the next inference call doesn't pay an extra round-trip on
 *      a 401.
 *   2. Calls `forceRefresh()` from its 401 handler — the upstream may
 *      reject a still-young access_token (e.g. revoked from chatgpt.com)
 *      and we should try once more before giving up.
 *
 * Both helpers throw `CodexAuthExpired` when refresh itself fails. The
 * gateway maps this to a UI banner; the CLI maps it to a "re-run
 * polymath llm login" hint.
 *
 * See `.kiro/specs/polymath-codex-auth/requirements.md` (R3.*) and
 * `design.md` (R3 — Refresh logic section) for the source of truth on
 * the OAuth grant, request body, and rotation rules.
 */

import { loadAuth, saveAuth } from "./auth_store.js";
import {
  CodexAuthExpired,
  type CodexAuthStored,
  type CodexTokens,
} from "./responses_protocol.js";

/** OpenAI's token endpoint — same one the Codex CLI hits. */
const TOKEN_URL = "https://auth.openai.com/oauth/token";

/**
 * Public client ID used by every first- and third-party Codex consumer
 * (Codex CLI, Roo Code, OpenCode, OpenClaw…). Documented in the
 * design doc; copied verbatim so the value is greppable.
 */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Same scope set the Codex CLI requests. */
const SCOPE = "openid profile email offline_access";

/**
 * Pre-emptive refresh window. Tokens are typically 30 minutes; we
 * refresh at 25 to leave headroom for clock drift and slow networks.
 */
const REFRESH_WINDOW_MS = 25 * 60 * 1000;

/**
 * Return tokens that are guaranteed to be < 25 minutes old. If the
 * stored `last_refresh` is still inside the window we return what's on
 * disk without touching the network; otherwise we refresh and persist
 * the new tokens.
 *
 * Throws if no auth has been stored yet (caller should run
 * `polymath llm login` or `polymath llm import-codex` first), or if the
 * refresh endpoint returns a non-200.
 */
export async function ensureFreshToken(): Promise<CodexTokens> {
  const auth = await loadAuth();
  if (!auth) {
    throw new CodexAuthExpired(
      "No Codex auth stored. Run `polymath llm login` or `polymath llm import-codex` first.",
    );
  }

  const ageMs = Date.now() - new Date(auth.last_refresh).getTime();
  // `ageMs` can be negative when the system clock has jumped backward
  // — treat that as "definitely fresh" rather than "definitely stale".
  if (ageMs >= 0 && ageMs < REFRESH_WINDOW_MS) {
    return auth.tokens;
  }

  return refreshAndSave(auth);
}

/**
 * Refresh unconditionally. Used by the adapter when an inference call
 * comes back 401 — the access_token may have been revoked server-side
 * even though our local clock still considers it fresh.
 */
export async function forceRefresh(): Promise<CodexTokens> {
  const auth = await loadAuth();
  if (!auth) {
    throw new CodexAuthExpired(
      "No Codex auth stored. Run `polymath llm login` or `polymath llm import-codex` first.",
    );
  }
  return refreshAndSave(auth);
}

/**
 * Internal: hit the token endpoint, persist the result. `account_id`
 * is preserved from the prior store because the refresh response
 * doesn't carry it. `refresh_token` may rotate — we use the new value
 * if present and fall back to the old one if the server reused it.
 */
async function refreshAndSave(prev: CodexAuthStored): Promise<CodexTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: prev.tokens.refresh_token,
    client_id: CLIENT_ID,
    scope: SCOPE,
  }).toString();

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    // Drain the body so the connection can be reused — fetch leaks the
    // socket otherwise on some Node builds. Best-effort; ignore errors.
    try { await res.body?.cancel(); } catch { /* swallow */ }
    throw new CodexAuthExpired(`Refresh failed: ${res.status}`);
  }

  let parsed: any;
  try {
    parsed = await res.json();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CodexAuthExpired(`Refresh response was not valid JSON: ${detail}`);
  }

  const access_token = parsed?.access_token;
  if (typeof access_token !== "string" || !access_token) {
    throw new CodexAuthExpired("Refresh response missing access_token.");
  }

  const newTokens: CodexTokens = {
    access_token,
    // id_token may or may not come back; fall back to the prior value
    // so adapters that decode it for display still work.
    id_token:
      typeof parsed?.id_token === "string" && parsed.id_token
        ? parsed.id_token
        : prev.tokens.id_token,
    // refresh_token rotates on some flows, stays put on others. Use the
    // new one if the server sent it, else keep the old one.
    refresh_token:
      typeof parsed?.refresh_token === "string" && parsed.refresh_token
        ? parsed.refresh_token
        : prev.tokens.refresh_token,
    // account_id is NOT returned by the refresh endpoint — preserve it
    // from the prior store. Losing it would break the adapter's
    // `OpenAI-Account-Id` header.
    account_id: prev.tokens.account_id,
  };

  const updated: CodexAuthStored = {
    auth_mode: "chatgpt",
    tokens: newTokens,
    last_refresh: new Date().toISOString(),
  };

  await saveAuth(updated);
  return newTokens;
}
