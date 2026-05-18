/**
 * Browser-based OAuth login for the Codex (ChatGPT subscription) flow.
 *
 * Mirrors the Codex CLI's behavior so users without Codex installed can
 * still sign in to Polymath from a single command:
 *
 *   1. Generate a PKCE verifier + S256 challenge.
 *   2. Bind a local HTTP listener on the first free port in 10501-10599.
 *   3. Open the user's default browser at `auth.openai.com/authorize`.
 *   4. Wait for the redirect back to `http://localhost:<port>/callback`,
 *      verify state, exchange the auth code for tokens.
 *   5. Decode the id_token's payload for `account_id`, save to the
 *      polymath store, respond with a clean "you can close this tab"
 *      page, then shut the listener down.
 *
 * Network calls (`fetch` to the OpenAI token endpoint) and the listener
 * itself are factored to be injectable for testing — see the
 * `LoginDeps` interface.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { exec } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { saveAuth } from "./auth_store.js";
import type { CodexAuthStored } from "./responses_protocol.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const SCOPE = "openid profile email offline_access";
const PORT_RANGE_START = 10501;
const PORT_RANGE_END = 10599;

export interface LoginOptions {
  /** Override the start of the port range (mainly for tests). */
  startPort?: number;
  /** Override the end of the port range (inclusive). */
  endPort?: number;
  /** Maximum time to wait for the user to complete the browser flow. */
  timeoutMs?: number;
  /** Suppress opening the browser (callers that already opened it). */
  skipOpenBrowser?: boolean;
  /** Stream progress messages back to the caller (e.g. SSE in the gateway). */
  onProgress?: (msg: string) => void;
}

export interface LoginResult {
  account_id: string;
  port: number;
  authorize_url: string;
}

/** Thin wrapper so tests can inject a fake fetch + listener + opener. */
export interface LoginDeps {
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => void;
  /** Override the listener factory. Default: the node:http server. */
  serverFactory?: typeof createServer;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(64));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function generateState(): string {
  return base64UrlEncode(randomBytes(32));
}

/**
 * Decode a JWT payload without signature verification. Used solely to
 * extract `account_id` (or fall back to `sub`) — the access_token is
 * still validated server-side on every API call so the lack of crypto
 * verification here is not a security gap.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length < 2) return {};
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "==".slice(0, (4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
  } catch {
    return {};
  }
}

function defaultOpenBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open"
    : platform === "win32" ? "start ''"
    : "xdg-open";
  // `start` on Windows runs through cmd.exe, so we route through `exec`.
  // On macOS / Linux this also works via the user's PATH.
  exec(`${cmd} "${url}"`, () => { /* swallow — non-fatal */ });
}

async function bindFreePort(
  start: number,
  end: number,
  factory: typeof createServer,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  for (let p = start; p <= end; p++) {
    const server = factory(handler);
    const ok = await new Promise<boolean>((resolve) => {
      const onError = () => { server.removeListener("listening", onListen); resolve(false); };
      const onListen = () => { server.removeListener("error", onError); resolve(true); };
      server.once("error", onError);
      server.once("listening", onListen);
      server.listen(p, "127.0.0.1");
    });
    if (ok) return { server, port: p };
    try { server.close(); } catch { /* swallow */ }
  }
  throw new Error(`No free port in range ${start}-${end}`);
}

interface CallbackPayload {
  code: string;
  state: string;
}

const SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Polymath — signed in</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;background:#0b0c10;color:#fff">
  <h1>✓ Signed in</h1>
  <p>You can close this tab and return to Polymath.</p>
</body></html>`;

const ERROR_HTML = (msg: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Polymath — login error</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;background:#1a0b0c;color:#fff">
  <h1>✗ Login failed</h1>
  <p>${msg.replace(/[<>&]/g, "")}</p>
</body></html>`;

/**
 * Run the full browser OAuth flow. Resolves with the imported
 * account_id once the listener has saved tokens to disk.
 */
export async function loginCodex(opts: LoginOptions = {}, deps: LoginDeps = {}): Promise<LoginResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
  const serverFactory = deps.serverFactory ?? createServer;
  const startPort = opts.startPort ?? PORT_RANGE_START;
  const endPort = opts.endPort ?? PORT_RANGE_END;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000; // 5 minutes
  const onProgress = opts.onProgress ?? (() => {});

  const { verifier, challenge } = generatePkce();
  const state = generateState();

  // Set up the callback listener BEFORE we surface the URL so we don't
  // race with a fast browser autocomplete redirect.
  let resolveCallback!: (cb: CallbackPayload) => void;
  let rejectCallback!: (err: Error) => void;
  const callbackPromise = new Promise<CallbackPayload>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.writeHead(400, { "content-type": "text/html" });
      res.end(ERROR_HTML("missing URL"));
      return;
    }
    const url = new URL(req.url, `http://localhost`);
    if (url.pathname !== "/callback") {
      res.writeHead(404, { "content-type": "text/html" });
      res.end(ERROR_HTML("unknown path"));
      return;
    }
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) {
      res.writeHead(400, { "content-type": "text/html" });
      res.end(ERROR_HTML(`OpenAI returned error: ${error}`));
      rejectCallback(new Error(`OAuth error: ${error}`));
      return;
    }
    if (!code || !returnedState) {
      res.writeHead(400, { "content-type": "text/html" });
      res.end(ERROR_HTML("missing code or state"));
      rejectCallback(new Error("Callback missing code or state"));
      return;
    }
    if (returnedState !== state) {
      res.writeHead(400, { "content-type": "text/html" });
      res.end(ERROR_HTML("state mismatch — possible CSRF, ignored"));
      rejectCallback(new Error("Callback state mismatch"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(SUCCESS_HTML);
    resolveCallback({ code, state: returnedState });
  };

  const { server, port } = await bindFreePort(startPort, endPort, serverFactory, handler);

  const redirectUri = `http://localhost:${port}/callback`;
  const authorizeUrl = `${AUTHORIZE_URL}?` + new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();

  onProgress(`listening on ${port}`);
  if (!opts.skipOpenBrowser) {
    openBrowser(authorizeUrl);
    onProgress("opening browser");
  }

  // Race the callback against a timeout so the listener can't leak forever.
  const timer = setTimeout(() => {
    rejectCallback(new Error("OAuth login timed out"));
  }, timeoutMs);

  let payload: CallbackPayload;
  try {
    payload = await callbackPromise;
  } finally {
    clearTimeout(timer);
    try { server.close(); } catch { /* swallow */ }
  }

  onProgress("exchanging code for tokens");
  const exchangeRes = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: payload.code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
  });

  if (!exchangeRes.ok) {
    const detail = await exchangeRes.text().catch(() => "");
    throw new Error(`Token exchange failed: HTTP ${exchangeRes.status} ${detail.slice(0, 200)}`);
  }

  const body: any = await exchangeRes.json();
  if (!body.access_token || !body.refresh_token) {
    throw new Error("Token exchange returned no access_token or refresh_token");
  }

  const idClaims = decodeJwtPayload(body.id_token ?? "");
  const accountId =
    (idClaims["https://api.openai.com/auth"] as any)?.user_id
    ?? (idClaims["account_id"] as string)
    ?? (idClaims["sub"] as string)
    ?? "";

  if (!accountId) {
    throw new Error("Could not extract account_id from id_token");
  }

  const stored: CodexAuthStored = {
    auth_mode: "chatgpt",
    tokens: {
      access_token: body.access_token,
      id_token: body.id_token ?? "",
      refresh_token: body.refresh_token,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  };
  await saveAuth(stored);

  onProgress(`signed in as ${accountId}`);
  return { account_id: accountId, port, authorize_url: authorizeUrl };
}
