import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = join(tmpdir(), "polymath-hub-test-" + Date.now());

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("installSkill", () => {
  it("downloads and writes SKILL.md", async () => {
    const body = "---\nname: test-skill\n---\nYou are a test skill.";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => body,
      headers: new Headers(),
    }));
    const { installSkill } = await import("../src/skills/hub.js");
    const result = await installSkill("test-skill", TMP);
    expect(result).toContain("Installed");
    const file = join(TMP, "skills", "test-skill", "SKILL.md");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe(body);
  });

  it("verifies SHA256 integrity", async () => {
    const body = "content";
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(body).digest("hex");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => body,
      headers: new Headers({ "x-sha256": hash }),
    }));
    const { installSkill } = await import("../src/skills/hub.js");
    const result = await installSkill("verified", TMP);
    expect(result).toContain("Installed");
  });

  it("rejects on integrity mismatch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "content",
      headers: new Headers({ "x-sha256": "badhash" }),
    }));
    const { installSkill } = await import("../src/skills/hub.js");
    const result = await installSkill("bad", TMP);
    expect(result).toContain("Integrity check failed");
  });

  it("handles network error gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const { installSkill } = await import("../src/skills/hub.js");
    const result = await installSkill("fail", TMP);
    expect(result).toContain("Error");
  });
});

describe("searchSkills", () => {
  it("returns results array", async () => {
    const data = [{ name: "summarize", description: "Summarize text" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => data,
    }));
    const { searchSkills } = await import("../src/skills/hub.js");
    const result = await searchSkills("summarize");
    expect(result).toEqual(data);
  });

  it("handles HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const { searchSkills } = await import("../src/skills/hub.js");
    const result = await searchSkills("fail");
    expect(result).toContain("Search failed");
  });
});
