/**
 * Workspace init + brand registry tests.
 *
 * Verifies:
 *   - init creates the bare-template tree, with NO brand subdirs by default
 *   - init --brands materializes brand-specific dirs
 *   - init refuses non-empty dirs without --force
 *   - check reports compliance accurately
 *   - brand registry persists in ~/.polymath/brands.json (mocked HOME)
 *   - the audit-test: shipped templates contain ZERO owner brand names
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  addBrand,
  checkWorkspace,
  initWorkspace,
  loadBrands,
  removeBrand,
} from "../src/workspace/init.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "polymath-init-test-"));
});

afterEach(() => {
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
});

describe("initWorkspace", () => {
  it("creates the bare template at an empty path", () => {
    const target = join(workDir, "ws");
    const result = initWorkspace(target);
    expect(result.ok).toBe(true);
    expect(existsSync(join(target, "input"))).toBe(true);
    expect(existsSync(join(target, "content"))).toBe(true);
    expect(existsSync(join(target, "output"))).toBe(true);
    expect(existsSync(join(target, "archive"))).toBe(true);
    expect(existsSync(join(target, "skills"))).toBe(true);
    expect(existsSync(join(target, ".polymath", "layout.json"))).toBe(true);
  });

  it("ships ZERO brand subdirectories when --brands is not passed", () => {
    const target = join(workDir, "ws");
    initWorkspace(target);
    const inputDirs = readdirSync(join(target, "input")).filter(
      (n) => !n.startsWith("."),
    );
    // README.md is allowed; no other entries.
    expect(inputDirs.filter((n) => n !== "README.md")).toEqual([]);
    const contentDirs = readdirSync(join(target, "content")).filter(
      (n) => !n.startsWith("."),
    );
    // pinterest/ ships as a generic platform dir, but no brand subdirs.
    expect(contentDirs.sort()).toEqual(["README.md", "pinterest"]);
  });

  it("materializes brand subdirs when --brands is provided", () => {
    const target = join(workDir, "ws");
    const result = initWorkspace(target, { brands: ["alpha", "beta"] });
    expect(result.ok).toBe(true);
    expect(result.brands).toEqual(["alpha", "beta"]);
    for (const brand of ["alpha", "beta"]) {
      expect(existsSync(join(target, "input", brand, "raw"))).toBe(true);
      expect(existsSync(join(target, "input", brand, "fixed"))).toBe(true);
      expect(existsSync(join(target, "content", brand, "reels"))).toBe(true);
      expect(existsSync(join(target, "content", brand, "long-form"))).toBe(true);
      expect(existsSync(join(target, "input", brand, "README.md"))).toBe(true);
    }
  });

  it("refuses init into a non-empty directory", () => {
    const target = join(workDir, "ws");
    require("node:fs").mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "existing.txt"), "hi", "utf-8");
    const result = initWorkspace(target);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not empty");
  });

  it("init --force overwrites a non-empty directory", () => {
    const target = join(workDir, "ws");
    require("node:fs").mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "existing.txt"), "hi", "utf-8");
    const result = initWorkspace(target, { force: true });
    expect(result.ok).toBe(true);
    expect(existsSync(join(target, "input"))).toBe(true);
  });

  it("brand README contains the brand name (template substitution)", () => {
    const target = join(workDir, "ws");
    initWorkspace(target, { brands: ["my-brand"] });
    const readme = readFileSync(join(target, "input", "my-brand", "README.md"), "utf-8");
    expect(readme).toContain("my-brand");
    expect(readme).not.toContain("{{BRAND}}");
  });
});

describe("checkWorkspace", () => {
  it("reports ok=true for a freshly inited workspace", () => {
    const target = join(workDir, "ws");
    initWorkspace(target);
    const r = checkWorkspace(target);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.marker).toBeDefined();
  });

  it("reports missing dirs for a hand-rolled workspace without init", () => {
    const target = join(workDir, "ws");
    require("node:fs").mkdirSync(join(target, "input"), { recursive: true });
    // Note: no content/output/archive/skills — should report missing.
    const r = checkWorkspace(target);
    expect(r.ok).toBe(false);
    expect(r.missing.sort()).toEqual(["archive", "content", "output", "skills"]);
    expect(r.notes.some((n) => n.includes("not initialized"))).toBe(true);
  });
});

describe("brand registry", () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    // Redirect HOME to a temp dir so we don't pollute the real ~/.polymath.
    originalHome = process.env.HOME ?? process.env.USERPROFILE;
    process.env.HOME = workDir;
    process.env.USERPROFILE = workDir;
    // Clean any lingering brands file from prior tests in same temp.
    const p = join(workDir, ".polymath", "brands.json");
    try { rmSync(p, { force: true }); } catch { /* */ }
  });

  afterEach(() => {
    if (originalHome) {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalHome;
    }
  });

  it("starts empty", () => {
    expect(loadBrands()).toEqual([]);
  });

  it("addBrand persists and de-duplicates", () => {
    addBrand("alpha");
    addBrand("alpha"); // duplicate
    addBrand("beta");
    const brands = loadBrands();
    expect(brands.sort()).toEqual(["alpha", "beta"]);
  });

  it("rejects invalid brand names", () => {
    expect(addBrand("").ok).toBe(false);
    expect(addBrand("name with spaces").ok).toBe(false);
    expect(addBrand("foo/bar").ok).toBe(false);
    expect(addBrand("a".repeat(100)).ok).toBe(false);
  });

  it("accepts conventional brand names", () => {
    expect(addBrand("alpha").ok).toBe(true);
    expect(addBrand("alpha-beta").ok).toBe(true);
    expect(addBrand("alpha_beta").ok).toBe(true);
    expect(addBrand("alpha.beta").ok).toBe(true);
    expect(addBrand("alpha123").ok).toBe(true);
  });

  it("removeBrand drops without affecting others", () => {
    addBrand("alpha");
    addBrand("beta");
    removeBrand("alpha");
    expect(loadBrands()).toEqual(["beta"]);
  });

  it("addBrand with workspace materializes brand directories", () => {
    const target = join(workDir, "ws");
    initWorkspace(target);
    const result = addBrand("gamma", target);
    expect(result.ok).toBe(true);
    expect(existsSync(join(target, "input", "gamma", "raw"))).toBe(true);
    expect(existsSync(join(target, "content", "gamma", "reels"))).toBe(true);
  });
});

describe("audit: shipped artifacts contain no owner-brand names", () => {
  it("templates/agent-layout/ has no references to owner brands", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const tplDir = resolve(here, "..", "templates", "agent-layout");
    expect(existsSync(tplDir)).toBe(true);

    const ownerBrands = ["brand-a", "brand-b", "creator-hub", "studio", "private-skill"];
    const seen: string[] = [];

    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith(".md")) {
          const txt = readFileSync(full, "utf-8").toLowerCase();
          for (const b of ownerBrands) {
            if (txt.includes(b)) seen.push(`${full}: contains "${b}"`);
          }
        }
      }
    }
    walk(tplDir);
    expect(seen).toEqual([]);
  });

  it("templates/path-rules.json has no references to owner brands", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rulesPath = resolve(here, "..", "templates", "path-rules.json");
    expect(existsSync(rulesPath)).toBe(true);
    const txt = readFileSync(rulesPath, "utf-8").toLowerCase();
    for (const b of ["brand-a", "brand-b", "creator-hub", "studio", "private-skill"]) {
      expect(txt).not.toContain(b);
    }
  });
});
