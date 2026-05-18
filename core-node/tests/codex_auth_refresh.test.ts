import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the auth store so the refresh tests never touch disk and we can
// assert exactly what gets persisted. Same pattern as
// `tests/codex_import.test.ts`.
vi.mock("../src/llm/codex/auth_store.js", () => ({
  loadAuth: vi.fn(),
  saveAuth: vi.fn(async () => {}),
  wipeAuth: vi.fn(async () => {}),
}));

import { ensureFreshToken, forceRefresh } from "../src/llm/codex/auth_refresh.js";
import { loadAuth, saveAuth } from "../src/llm/codex/auth_store.js";
import {
  CodexAuthExpired,
  type CodexAuthStored,
} from "../src/llm/codex/responses_protocol.js";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

function buildAuth(overrides: Partial<CodexAuthStored> = {}): CodexAuthStored {
  return {
    auth_mode: "chatgpt",
    tokens: {
      access_token: "old-access",
      id_token: "old-id",
      refresh_token: "old-refresh",
      account_id: "acct_123",
    },
    last_refresh: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build a Response-like object that the production code will be happy
 * with. We don't bother with the full Fetch API surface — only `ok`,
 * `status`, `json()`, and `body.cancel()` are read.
 */
function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: { cancel: vi.fn(async () => {}) },
    json: async () => body,
  };
}

describe("ensureFreshToken", () => {
  beforeEach(() => {
    vi.mocked(loadAuth).mockReset();
    vi.mocked(saveAuth).mockReset();
    vi.mocked(saveAuth).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns existing tokens when last_refresh is < 25 minutes ago and never calls fetch", async () => {
    const fresh = buildAuth({
      last_refresh: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    vi.mocked(loadAuth).mockResolvedValue(fresh);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await ensureFreshToken();

    expect(tokens).toEqual(fresh.tokens);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveAuth).not.toHaveBeenCalled();
  });

  it("refreshes when last_refresh is > 25 minutes ago, persists the new tokens, and returns them", async () => {
    const stale = buildAuth({
      last_refresh: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    vi.mocked(loadAuth).mockResolvedValue(stale);

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        access_token: "new-access",
        id_token: "new-id",
        refresh_token: "new-refresh",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const before = Date.now();
    const tokens = await ensureFreshToken();
    const after = Date.now();

    // Hits the right URL with the right body shape.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

    const params = new URLSearchParams(init.body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("old-refresh");
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("scope")).toBe("openid profile email offline_access");

    // Returned tokens reflect the refresh response.
    expect(tokens.access_token).toBe("new-access");
    expect(tokens.id_token).toBe("new-id");
    expect(tokens.refresh_token).toBe("new-refresh");

    // Persisted shape matches and last_refresh was bumped to ~now.
    expect(saveAuth).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveAuth).mock.calls[0][0];
    expect(saved.auth_mode).toBe("chatgpt");
    expect(saved.tokens.access_token).toBe("new-access");
    const ts = new Date(saved.last_refresh).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 1);
  });

  it("preserves account_id across refresh (the endpoint never returns it)", async () => {
    const stale = buildAuth({
      tokens: {
        access_token: "old-access",
        id_token: "old-id",
        refresh_token: "old-refresh",
        account_id: "acct_xyz",
      },
      last_refresh: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    vi.mocked(loadAuth).mockResolvedValue(stale);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          access_token: "new-access",
          id_token: "new-id",
          refresh_token: "new-refresh",
          // No account_id field — this matches what the real OpenAI
          // refresh endpoint returns.
        }),
      ),
    );

    const tokens = await ensureFreshToken();

    expect(tokens.account_id).toBe("acct_xyz");
    const saved = vi.mocked(saveAuth).mock.calls[0][0];
    expect(saved.tokens.account_id).toBe("acct_xyz");
  });

  it("throws CodexAuthExpired on 401 from the refresh endpoint", async () => {
    const stale = buildAuth({
      last_refresh: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    vi.mocked(loadAuth).mockResolvedValue(stale);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, {})));

    await expect(ensureFreshToken()).rejects.toBeInstanceOf(CodexAuthExpired);
    await expect(ensureFreshToken()).rejects.toThrow(/401/);
    expect(saveAuth).not.toHaveBeenCalled();
  });

  it("throws CodexAuthExpired on 403 from the refresh endpoint", async () => {
    const stale = buildAuth({
      last_refresh: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    vi.mocked(loadAuth).mockResolvedValue(stale);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(403, {})));

    await expect(ensureFreshToken()).rejects.toBeInstanceOf(CodexAuthExpired);
    expect(saveAuth).not.toHaveBeenCalled();
  });

  it("throws CodexAuthExpired when no auth has been stored", async () => {
    vi.mocked(loadAuth).mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureFreshToken()).rejects.toBeInstanceOf(CodexAuthExpired);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("forceRefresh", () => {
  beforeEach(() => {
    vi.mocked(loadAuth).mockReset();
    vi.mocked(saveAuth).mockReset();
    vi.mocked(saveAuth).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("always calls fetch even when last_refresh is well within the 25-minute window", async () => {
    const fresh = buildAuth({
      // Refreshed 1 second ago — ensureFreshToken would skip the network.
      last_refresh: new Date(Date.now() - 1000).toISOString(),
    });
    vi.mocked(loadAuth).mockResolvedValue(fresh);

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        access_token: "forced-access",
        id_token: "forced-id",
        refresh_token: "forced-refresh",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await forceRefresh();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokens.access_token).toBe("forced-access");
    expect(saveAuth).toHaveBeenCalledTimes(1);
  });

  it("uses the rotated refresh_token when the server returns a new one", async () => {
    vi.mocked(loadAuth).mockResolvedValue(buildAuth());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          access_token: "new-access",
          id_token: "new-id",
          refresh_token: "rotated-refresh",
        }),
      ),
    );

    const tokens = await forceRefresh();

    expect(tokens.refresh_token).toBe("rotated-refresh");
    const saved = vi.mocked(saveAuth).mock.calls[0][0];
    expect(saved.tokens.refresh_token).toBe("rotated-refresh");
  });

  it("keeps the prior refresh_token when the server omits one (no rotation)", async () => {
    vi.mocked(loadAuth).mockResolvedValue(buildAuth());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          access_token: "new-access",
          id_token: "new-id",
          // refresh_token intentionally absent.
        }),
      ),
    );

    const tokens = await forceRefresh();

    expect(tokens.refresh_token).toBe("old-refresh");
    const saved = vi.mocked(saveAuth).mock.calls[0][0];
    expect(saved.tokens.refresh_token).toBe("old-refresh");
  });

  it("keeps the prior id_token when the server omits one", async () => {
    vi.mocked(loadAuth).mockResolvedValue(buildAuth());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          access_token: "new-access",
          // id_token + refresh_token intentionally absent.
        }),
      ),
    );

    const tokens = await forceRefresh();

    expect(tokens.id_token).toBe("old-id");
  });

  it("throws CodexAuthExpired on 401 from the refresh endpoint", async () => {
    vi.mocked(loadAuth).mockResolvedValue(buildAuth());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, {})));

    await expect(forceRefresh()).rejects.toBeInstanceOf(CodexAuthExpired);
    expect(saveAuth).not.toHaveBeenCalled();
  });
});
