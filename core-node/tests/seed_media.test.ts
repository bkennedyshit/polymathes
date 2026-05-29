/**
 * Media seed tests using synthetic fixture files (no ffprobe required).
 *
 * Verifies:
 *   - walks a tree, classifies by extension
 *   - applies path-inference for brand/category/intent
 *   - skips non-media extensions
 *   - skips paths matching skip rules (skills/, .polymath/, etc.)
 *   - upserts are idempotent
 *   - --dry-run doesn't write
 *   - --since filters by mtime
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/db/migrate.js";
import { MediaEpisodic } from "../src/memory/media_episodic.js";
import { seedMedia } from "../src/workspace/seed_media.js";
import { _resetPathRulesCache } from "../src/memory/path_inference.js";

let workDir: string;
let db: Database.Database;
let ep: MediaEpisodic;

function touch(path: string, content = "x"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

beforeEach(() => {
  _resetPathRulesCache();
  workDir = mkdtempSync(join(tmpdir(), "polymath-seed-test-"));
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  ep = new MediaEpisodic(db);
});

afterEach(() => {
  db.close();
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
});

describe("seedMedia", () => {
  it("classifies videos, images, audio, text by extension", async () => {
    touch(join(workDir, "input", "alpha", "raw", "v1.mp4"));
    touch(join(workDir, "input", "alpha", "raw", "img1.png"));
    touch(join(workDir, "input", "alpha", "raw", "voice.wav"));
    touch(join(workDir, "input", "alpha", "raw", "notes.txt")); // now indexed as text (RAG-able)
    touch(join(workDir, "input", "alpha", "raw", "data.bin")); // skipped — unsupported

    const result = await seedMedia(workDir, ep);
    expect(result.registered).toBe(4); // video + image + audio + text
    expect(result.skipped).toBeGreaterThanOrEqual(1); // .bin skipped

    const all = ep.query();
    const kinds = all.map((m) => m.kind).sort();
    expect(kinds).toEqual(["audio", "image", "text", "video"]);
  });

  it("infers brand and category from path", async () => {
    touch(join(workDir, "input", "alpha", "raw", "v1.mp4"));
    touch(join(workDir, "content", "beta", "reels", "r1.mp4"));
    touch(join(workDir, "content", "pinterest", "merch pins", "pin1.png"));

    await seedMedia(workDir, ep);
    const items = ep.query();

    const v1 = items.find((m) => m.path.endsWith("v1.mp4"))!;
    expect(v1.brand).toBe("alpha");
    expect(v1.category).toBe("raw");
    expect(v1.intent).toBe("agent-input");

    const r1 = items.find((m) => m.path.endsWith("r1.mp4"))!;
    expect(r1.brand).toBe("beta");
    expect(r1.category).toBe("reel");

    const pin = items.find((m) => m.path.endsWith("pin1.png"))!;
    expect(pin.category).toBe("pin");
    expect(pin.metadata?.platform).toBe("pinterest");
    expect(pin.metadata?.pin_type).toBe("merch pins");
  });

  it("skips paths matched by skip rules", async () => {
    touch(join(workDir, "skills", "my-skill", "asset.png"));
    touch(join(workDir, ".polymath", "polymath.db"));
    touch(join(workDir, "logs", "gateway.log"));
    touch(join(workDir, "AGENT_BRAIN", "notes.md"));
    // One real file so the test isn't vacuously true.
    touch(join(workDir, "input", "alpha", "raw", "real.mp4"));

    const result = await seedMedia(workDir, ep);
    expect(result.registered).toBe(1);
    expect(ep.query()[0]?.path.endsWith("real.mp4")).toBe(true);
  });

  it("is idempotent — re-seeding doesn't duplicate rows", async () => {
    touch(join(workDir, "input", "alpha", "raw", "v1.mp4"));
    await seedMedia(workDir, ep);
    await seedMedia(workDir, ep);
    await seedMedia(workDir, ep);
    expect(ep.query()).toHaveLength(1);
  });

  it("--dry-run scans but does not write", async () => {
    touch(join(workDir, "input", "alpha", "raw", "v1.mp4"));
    touch(join(workDir, "input", "alpha", "raw", "v2.mp4"));
    const result = await seedMedia(workDir, ep, { dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.registered).toBe(2);
    expect(ep.query()).toHaveLength(0); // no writes
  });

  it("emits warnings for files larger than maxFileMb", async () => {
    const big = join(workDir, "input", "alpha", "raw", "big.mp4");
    touch(big);
    // Stub size by passing maxFileMb=0 so any non-empty file is "too big".
    const result = await seedMedia(workDir, ep, { maxFileMb: 0 });
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.warnings.some((w) => w.includes("skipped large file"))).toBe(true);
  });

  it("--force-large bypasses the size guardrail", async () => {
    touch(join(workDir, "input", "alpha", "raw", "big.mp4"));
    const result = await seedMedia(workDir, ep, { maxFileMb: 0, forceLarge: true });
    expect(result.registered).toBe(1);
  });

  it("--since filters by mtime", async () => {
    touch(join(workDir, "input", "alpha", "raw", "old.mp4"));
    touch(join(workDir, "input", "alpha", "raw", "new.mp4"));
    // Mark old.mp4 as modified far in the past
    const oldTime = new Date("2020-01-01");
    utimesSync(join(workDir, "input", "alpha", "raw", "old.mp4"), oldTime, oldTime);

    const result = await seedMedia(workDir, ep, { since: "2024-01-01T00:00:00Z" });
    expect(result.registered).toBe(1);
    expect(ep.query()[0]?.path.endsWith("new.mp4")).toBe(true);
  });

  it("aggregates by_brand and by_category", async () => {
    touch(join(workDir, "input", "alpha", "raw", "v1.mp4"));
    touch(join(workDir, "input", "alpha", "raw", "v2.mp4"));
    touch(join(workDir, "input", "beta", "raw", "v3.mp4"));
    touch(join(workDir, "content", "alpha", "reels", "r1.mp4"));

    const result = await seedMedia(workDir, ep);
    expect(result.by_brand.alpha).toBe(3);
    expect(result.by_brand.beta).toBe(1);
    expect(result.by_category.raw).toBe(3);
    expect(result.by_category.reel).toBe(1);
  });

  it("returns empty result for non-existent path", async () => {
    const result = await seedMedia(join(workDir, "does-not-exist"), ep);
    expect(result.registered).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
