import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadAuth,
  saveAuth,
  wipeAuth,
} from "../src/llm/codex/auth_store.js";
import type { CodexAuthStored } from "../src/llm/codex/responses_protocol.js";

const IS_WINDOWS = process.platform === "win32";

function sampleAuth(): CodexAuthStored {
  return {
    auth_mode: "chatgpt",
    tokens: {
      access_token: "access-abc",
      id_token: "id-xyz",
      refresh_token: "refresh-123",
      account_id: "acct_test",
    },
    last_refresh: "2026-05-17T12:00:00.000Z",
  };
}

describe("codex auth_store", () => {
  let polymathHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    polymathHome = mkdtempSync(join(tmpdir(), "polymath-codex-auth-"));
    originalHome = process.env.POLYMATH_HOME;
    process.env.POLYMATH_HOME = polymathHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.POLYMATH_HOME;
    } else {
      process.env.POLYMATH_HOME = originalHome;
    }
    try { rmSync(polymathHome, { recursive: true, force: true }); } catch { /* swallow */ }
  });

  it("save → load round-trips the stored value", async () => {
    const auth = sampleAuth();
    await saveAuth(auth);
    const loaded = await loadAuth();
    expect(loaded).toEqual(auth);
  });

  it("loadAuth returns null when the file is missing", async () => {
    const loaded = await loadAuth();
    expect(loaded).toBeNull();
  });

  it("wipeAuth deletes the file and is idempotent", async () => {
    await saveAuth(sampleAuth());
    const path = join(polymathHome, "codex-auth.json");
    expect(existsSync(path)).toBe(true);

    await wipeAuth();
    expect(existsSync(path)).toBe(false);

    // Idempotent — a second wipe must not throw.
    await expect(wipeAuth()).resolves.toBeUndefined();
  });

  it.skipIf(IS_WINDOWS)("save sets file mode 0600", async () => {
    await saveAuth(sampleAuth());
    const path = join(polymathHome, "codex-auth.json");
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("save creates the polymath home dir if missing", async () => {
    // Point at a path that doesn't exist yet so saveAuth has to mkdir.
    const nested = join(polymathHome, "nested-home");
    process.env.POLYMATH_HOME = nested;

    await saveAuth(sampleAuth());
    expect(existsSync(join(nested, "codex-auth.json"))).toBe(true);
  });

  it("save overwrites existing file atomically", async () => {
    const first = sampleAuth();
    await saveAuth(first);

    const second: CodexAuthStored = {
      ...first,
      tokens: { ...first.tokens, access_token: "access-rotated" },
      last_refresh: "2026-05-17T13:00:00.000Z",
    };
    await saveAuth(second);

    const loaded = await loadAuth();
    expect(loaded).toEqual(second);
  });

  it("loadAuth surfaces parse errors on a corrupted store", async () => {
    const path = join(polymathHome, "codex-auth.json");
    writeFileSync(path, "{ not valid json", "utf-8");
    await expect(loadAuth()).rejects.toThrow();
  });
});
