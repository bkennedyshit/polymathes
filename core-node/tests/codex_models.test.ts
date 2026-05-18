import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock auth_refresh so the test never makes a real OpenAI call.
vi.mock("../src/llm/codex/auth_refresh.js", () => ({
  ensureFreshToken: vi.fn(async () => ({
    access_token: "access-test",
    id_token: "id-test",
    refresh_token: "refresh-test",
    account_id: "acct_test",
  })),
}));

import { discoverModels, loadModelsCache } from "../src/llm/codex/models.js";
import { ensureFreshToken } from "../src/llm/codex/auth_refresh.js";
import { CodexAuthExpired } from "../src/llm/codex/responses_protocol.js";

describe("codex models discovery", () => {
  let polymathHome: string;
  const origHome = process.env.POLYMATH_HOME;

  beforeEach(() => {
    polymathHome = mkdtempSync(join(tmpdir(), "polymath-models-"));
    process.env.POLYMATH_HOME = polymathHome;
    vi.mocked(ensureFreshToken).mockClear();
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.POLYMATH_HOME;
    else process.env.POLYMATH_HOME = origHome;
    rmSync(polymathHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("hits the upstream once and caches the result on disk", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        data: [
          { id: "gpt-5.5", object: "model", display_name: "GPT-5.5" },
          { id: "gpt-5", object: "model" },
        ],
      }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const cache = await discoverModels({ version: "0.1.1" });
    expect(cache.models).toHaveLength(2);
    expect(cache.models[0].id).toBe("gpt-5.5");
    expect(cache.models[0].label).toBe("GPT-5.5");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Cache file written.
    const cachePath = join(polymathHome, "codex-models.json");
    expect(existsSync(cachePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(onDisk.account_id).toBe("acct_test");

    // Subsequent call hits cache, not network.
    fetchMock.mockClear();
    const cached = await discoverModels({ version: "0.1.1" });
    expect(cached.models).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("force-refreshes when refresh: true is passed", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ id: "gpt-5.5", object: "model" }] }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await discoverModels({ version: "0.1.1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await discoverModels({ version: "0.1.1", refresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws CodexAuthExpired on 401", async () => {
    const fetchMock = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverModels({ version: "0.1.1" })).rejects.toBeInstanceOf(CodexAuthExpired);
  });

  it("falls back to a stale cache when the upstream is unreachable", async () => {
    // Pre-seed a cache.
    mkdirSync(polymathHome, { recursive: true });
    const stale = {
      fetched_at: "2026-01-01T00:00:00.000Z",
      account_id: "acct_test",
      models: [{ id: "gpt-5.5" }],
    };
    writeFileSync(join(polymathHome, "codex-models.json"), JSON.stringify(stale), "utf-8");

    // Network 500.
    const fetchMock = vi.fn(async () => new Response("err", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await discoverModels({ version: "0.1.1", refresh: true });
    expect(result.models[0].id).toBe("gpt-5.5");
    // Cache untouched (still stale fetched_at).
    expect(result.fetched_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("loadModelsCache returns null when no cache exists", () => {
    expect(loadModelsCache()).toBeNull();
  });
});
