import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock saveAuth so the test never touches the real polymath_home — and so
// we can assert on the exact shape passed in. wipeAuth/loadAuth aren't
// used by the import path but we mock them anyway to keep the module
// surface intact.
vi.mock("../src/llm/codex/auth_store.js", () => ({
  saveAuth: vi.fn(async () => {}),
  loadAuth: vi.fn(async () => null),
  wipeAuth: vi.fn(async () => {}),
}));

import { importCodexAuth } from "../src/llm/codex/import_codex.js";
import { saveAuth } from "../src/llm/codex/auth_store.js";

const VALID_AUTH = {
  auth_mode: "chatgpt",
  tokens: {
    access_token: "access-abc",
    id_token: "id-abc",
    refresh_token: "refresh-abc",
    account_id: "acct_123",
  },
  last_refresh: "2026-05-17T00:00:00.000Z",
};

describe("importCodexAuth", () => {
  let tmpRoot: string;
  let codexHome: string;
  const origCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "polymath-codex-import-"));
    codexHome = join(tmpRoot, ".codex");
    mkdirSync(codexHome, { recursive: true });
    process.env.CODEX_HOME = codexHome;
    vi.mocked(saveAuth).mockClear();
  });

  afterEach(() => {
    if (origCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = origCodexHome;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("imports a valid Codex auth file and saves the tokens", async () => {
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify(VALID_AUTH));

    const result = await importCodexAuth({ yes: true });

    expect(result.account_id).toBe("acct_123");
    expect(saveAuth).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveAuth).mock.calls[0][0];
    expect(saved).toEqual({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "access-abc",
        id_token: "id-abc",
        refresh_token: "refresh-abc",
        account_id: "acct_123",
      },
      last_refresh: "2026-05-17T00:00:00.000Z",
    });
  });

  it("defaults last_refresh to now when the source file omits it", async () => {
    const { last_refresh: _omit, ...withoutRefresh } = VALID_AUTH;
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify(withoutRefresh));

    const before = Date.now();
    await importCodexAuth({ yes: true });
    const after = Date.now();

    expect(saveAuth).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveAuth).mock.calls[0][0];
    const ts = new Date(saved.last_refresh).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 1);
  });

  it("throws a helpful error when the source file is missing", async () => {
    // Don't write auth.json — directory exists but file does not.
    await expect(importCodexAuth({ yes: true })).rejects.toThrow(
      /No Codex auth file at .*auth\.json.*polymath llm login/
    );
    expect(saveAuth).not.toHaveBeenCalled();
  });

  it("throws when auth_mode is not 'chatgpt'", async () => {
    const wrongMode = { ...VALID_AUTH, auth_mode: "apikey" };
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify(wrongMode));

    await expect(importCodexAuth({ yes: true })).rejects.toThrow(
      /'apikey' mode, expected 'chatgpt'/
    );
    expect(saveAuth).not.toHaveBeenCalled();
  });

  it("throws when required token fields are missing", async () => {
    const missingFields = {
      auth_mode: "chatgpt",
      tokens: { access_token: "only-access" },
    };
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify(missingFields));

    await expect(importCodexAuth({ yes: true })).rejects.toThrow(
      /missing required fields/
    );
    expect(saveAuth).not.toHaveBeenCalled();
  });
});
