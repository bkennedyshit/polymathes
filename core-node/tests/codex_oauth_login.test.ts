import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, IncomingMessage, ServerResponse } from "node:http";

import { loginCodex } from "../src/llm/codex/oauth_login.js";

/**
 * id_token payload constructor — base64url-encodes a fake JWT with
 * `sub` so the login flow can extract account_id without us shipping a
 * real signing key.
 */
function fakeIdToken(payload: Record<string, unknown>): string {
  const b64u = (s: string) =>
    Buffer.from(s, "utf-8").toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return [b64u(JSON.stringify({ alg: "none" })), b64u(JSON.stringify(payload)), ""].join(".");
}

describe("loginCodex OAuth flow", () => {
  let polymathHome: string;
  const origHome = process.env.POLYMATH_HOME;

  beforeEach(() => {
    polymathHome = mkdtempSync(join(tmpdir(), "polymath-oauth-"));
    process.env.POLYMATH_HOME = polymathHome;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.POLYMATH_HOME;
    else process.env.POLYMATH_HOME = origHome;
    rmSync(polymathHome, { recursive: true, force: true });
  });

  it("completes the flow and saves tokens to ~/.polymath/codex-auth.json", async () => {
    // Mock fetch — returns the token-exchange response.
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      const body = init.body as string;
      // Sanity: body must include the verifier and our auth code.
      expect(body).toContain("grant_type=authorization_code");
      expect(body).toContain("code_verifier=");
      expect(body).toContain("code=test-auth-code");
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          id_token: fakeIdToken({ sub: "acct_login_test" }),
          refresh_token: "new-refresh",
        }),
        { status: 200 },
      );
    });

    // openBrowser stub captures the URL and immediately fires the
    // callback so the listener resolves without a real browser hop.
    let capturedAuthorizeUrl = "";
    const openBrowser = (url: string) => {
      capturedAuthorizeUrl = url;
      const u = new URL(url);
      const state = u.searchParams.get("state")!;
      const redirect = u.searchParams.get("redirect_uri")!;
      // Hit the listener immediately.
      setTimeout(async () => {
        try {
          await fetch(`${redirect}?code=test-auth-code&state=${state}`);
        } catch { /* swallow — test will time out if it really fails */ }
      }, 10);
    };

    const result = await loginCodex(
      { startPort: 21501, endPort: 21599, timeoutMs: 5_000 },
      { fetchImpl: fetchMock as any, openBrowser },
    );

    expect(result.account_id).toBe("acct_login_test");
    expect(capturedAuthorizeUrl).toContain("code_challenge_method=S256");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Tokens persisted with the right shape.
    const stored = JSON.parse(readFileSync(join(polymathHome, "codex-auth.json"), "utf-8"));
    expect(stored.auth_mode).toBe("chatgpt");
    expect(stored.tokens.access_token).toBe("new-access");
    expect(stored.tokens.refresh_token).toBe("new-refresh");
    expect(stored.tokens.account_id).toBe("acct_login_test");
    expect(typeof stored.last_refresh).toBe("string");
  });

  it("rejects with state-mismatch error if the callback state is wrong", async () => {
    const fetchMock = vi.fn();
    const openBrowser = (url: string) => {
      const u = new URL(url);
      const redirect = u.searchParams.get("redirect_uri")!;
      // Send a wrong state on purpose.
      setTimeout(async () => {
        try {
          await fetch(`${redirect}?code=test-auth-code&state=wrong-state`);
        } catch { /* swallow */ }
      }, 10);
    };

    await expect(
      loginCodex(
        { startPort: 21601, endPort: 21699, timeoutMs: 5_000 },
        { fetchImpl: fetchMock as any, openBrowser },
      ),
    ).rejects.toThrow(/state mismatch/i);

    // Token endpoint never hit.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(polymathHome, "codex-auth.json"))).toBe(false);
  });

  it("times out cleanly if the callback never arrives", async () => {
    const fetchMock = vi.fn();
    const openBrowser = () => { /* no-op; never fires the callback */ };

    await expect(
      loginCodex(
        { startPort: 21701, endPort: 21799, timeoutMs: 200 },
        { fetchImpl: fetchMock as any, openBrowser },
      ),
    ).rejects.toThrow(/timed out/i);
  });
});
