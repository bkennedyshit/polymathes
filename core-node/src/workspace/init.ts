/**
 * Workspace initialization — creates the canonical agent layout at a
 * user-chosen path and manages the per-workspace brand registry.
 *
 * Brand-agnostic by design. The shipped template contains ZERO brand
 * directories. Brands materialize only when the user names them via
 * `polymath init --brands` or `polymath brands add`.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export interface InitOptions {
  /** Pre-fill brand subdirectories at init time. */
  brands?: string[];
  /** Allow init into a non-empty directory. */
  force?: boolean;
}

export interface InitResult {
  ok: boolean;
  path: string;
  brands: string[];
  created: string[];      // absolute paths of files we created
  error?: string;
}

export interface LayoutMarker {
  version: number;
  initialized_at: string;
  brands: string[];
  template_version: number;
}

const LAYOUT_MARKER_VERSION = 1;
const TEMPLATE_VERSION = 1;

/**
 * Locate the bundled template directory. Works whether we're running from
 * source (tsx watch) or from the bundled CJS in dist/.
 */
function findTemplateDir(): string {
  // import.meta.url survives the esbuild banner shim because main.ts adds
  // __importMetaUrl. From src/workspace/init.ts the template is at
  // ../../templates/agent-layout/. From dist/polymath.cjs it's at
  // ./templates/agent-layout/.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "templates", "agent-layout"),
    resolve(here, "..", "templates", "agent-layout"),
    resolve(here, "templates", "agent-layout"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `template directory not found near ${here}. Build artifacts may be missing.`,
  );
}

/** Locate path-rules.json shipped alongside the template. */
export function findShippedPathRules(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "templates", "path-rules.json"),
    resolve(here, "..", "templates", "path-rules.json"),
    resolve(here, "templates", "path-rules.json"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Render `{{BRAND}}` placeholders in a template string.
 */
function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : `{{${key}}}`,
  );
}

/**
 * Materialize the brand-specific subtree and README under `<path>/input/<brand>/`
 * and `<path>/content/<brand>/{reels,long-form,static,static-images,talking-head}/`.
 */
function materializeBrand(rootPath: string, brand: string): string[] {
  const created: string[] = [];
  const brandReadmeTemplate = resolve(
    findTemplateDir(),
    "BRAND_README_TEMPLATE.md",
  );
  const brandReadmeBody = existsSync(brandReadmeTemplate)
    ? render(readFileSync(brandReadmeTemplate, "utf-8"), { BRAND: brand })
    : `# ${brand}\n\nBrand-scoped content directory.\n`;

  const dirs = [
    join("input", brand),
    join("input", brand, "raw"),
    join("input", brand, "fixed"),
    join("content", brand),
    join("content", brand, "reels"),
    join("content", brand, "long-form"),
    join("content", brand, "static"),
    join("content", brand, "static-images"),
    join("content", brand, "talking-head"),
  ];

  for (const rel of dirs) {
    const abs = join(rootPath, rel);
    mkdirSync(abs, { recursive: true });
    // .gitkeep so the empty dir survives version control if the user
    // chooses to commit their workspace structure (skills/.gitignored
    // already takes care of the private bits).
    const gitkeep = join(abs, ".gitkeep");
    if (!existsSync(gitkeep)) {
      writeFileSync(gitkeep, "", "utf-8");
      created.push(gitkeep);
    }
  }

  // Top-level brand README
  const brandReadmePath = join(rootPath, "input", brand, "README.md");
  if (!existsSync(brandReadmePath)) {
    writeFileSync(brandReadmePath, brandReadmeBody, "utf-8");
    created.push(brandReadmePath);
  }
  const contentBrandReadme = join(rootPath, "content", brand, "README.md");
  if (!existsSync(contentBrandReadme)) {
    writeFileSync(contentBrandReadme, brandReadmeBody, "utf-8");
    created.push(contentBrandReadme);
  }

  return created;
}

/**
 * Recursively check if a directory is empty (ignoring .git, .DS_Store, Thumbs.db).
 */
function isEffectivelyEmpty(p: string): boolean {
  if (!existsSync(p)) return true;
  const entries = readdirSync(p).filter(
    (e) => !["..", ".", ".git", ".DS_Store", "Thumbs.db", "desktop.ini"].includes(e),
  );
  return entries.length === 0;
}

/**
 * Initialize a workspace at the given path. Refuses non-empty directories
 * unless `force` is set. Materializes brand subdirectories for any brands
 * supplied.
 */
export function initWorkspace(targetPath: string, opts: InitOptions = {}): InitResult {
  const root = resolve(targetPath);
  const created: string[] = [];

  if (existsSync(root) && !isEffectivelyEmpty(root) && !opts.force) {
    return {
      ok: false,
      path: root,
      brands: [],
      created: [],
      error:
        `target directory is not empty: ${root}. ` +
        `Use --force to init anyway, or pick a fresh path.`,
    };
  }

  // 1. Copy the bundled template tree.
  const tpl = findTemplateDir();
  mkdirSync(root, { recursive: true });
  cpSync(tpl, root, {
    recursive: true,
    force: true,
    // Don't copy the brand-README template itself — it's source, not workspace content.
    filter: (src) => !src.endsWith("BRAND_README_TEMPLATE.md"),
  });

  // 2. Materialize brand subdirs if requested.
  const brands = (opts.brands ?? []).map((b) => b.trim()).filter(Boolean);
  for (const b of brands) {
    created.push(...materializeBrand(root, b));
  }

  // 3. Write the marker file so we know this is a Polymath workspace.
  const markerDir = join(root, ".polymath");
  mkdirSync(markerDir, { recursive: true });
  const marker: LayoutMarker = {
    version: LAYOUT_MARKER_VERSION,
    initialized_at: new Date().toISOString(),
    brands,
    template_version: TEMPLATE_VERSION,
  };
  const markerPath = join(markerDir, "layout.json");
  writeFileSync(markerPath, JSON.stringify(marker, null, 2), "utf-8");
  created.push(markerPath);

  return { ok: true, path: root, brands, created };
}

/**
 * Compliance check — what's missing from an existing workspace?
 */
export function checkWorkspace(targetPath: string): {
  ok: boolean;
  path: string;
  marker?: LayoutMarker;
  missing: string[];
  notes: string[];
} {
  const root = resolve(targetPath);
  const missing: string[] = [];
  const notes: string[] = [];

  if (!existsSync(root)) {
    return { ok: false, path: root, missing: [root], notes: ["path does not exist"] };
  }

  const required = ["input", "content", "output", "archive", "skills"];
  for (const dir of required) {
    if (!existsSync(join(root, dir))) missing.push(dir);
  }

  let marker: LayoutMarker | undefined;
  const markerPath = join(root, ".polymath", "layout.json");
  if (existsSync(markerPath)) {
    try {
      marker = JSON.parse(readFileSync(markerPath, "utf-8"));
    } catch {
      notes.push(".polymath/layout.json is corrupt or unreadable");
    }
  } else {
    notes.push("no .polymath/layout.json — workspace was not initialized by `polymath init`");
  }

  if (marker && marker.template_version < TEMPLATE_VERSION) {
    notes.push(
      `workspace template version is ${marker.template_version}, current is ${TEMPLATE_VERSION}. Consider re-running init in a fresh dir to see what's new.`,
    );
  }

  return { ok: missing.length === 0, path: root, marker, missing, notes };
}

// ─── Brand registry ───────────────────────────────────────────────────

interface BrandsFile {
  version: number;
  brands: string[];
}

const BRANDS_FILE_VERSION = 1;
const brandsPath = () => join(homedir(), ".polymath", "brands.json");

export function loadBrands(): string[] {
  const p = brandsPath();
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as BrandsFile;
    return Array.isArray(raw.brands) ? raw.brands : [];
  } catch {
    return [];
  }
}

function saveBrands(brands: string[]): void {
  const p = brandsPath();
  mkdirSync(dirname(p), { recursive: true });
  const data: BrandsFile = {
    version: BRANDS_FILE_VERSION,
    brands: [...new Set(brands)].sort(),
  };
  writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Add a brand. Idempotent. If `workspacePath` is provided, also
 * materializes the brand subdirectories there.
 */
export function addBrand(
  brand: string,
  workspacePath?: string,
): { ok: boolean; brand: string; created?: string[]; error?: string } {
  const trimmed = brand.trim();
  if (!trimmed) return { ok: false, brand: "", error: "brand name cannot be empty" };
  if (!/^[a-z0-9][a-z0-9._\-]{0,63}$/i.test(trimmed)) {
    return {
      ok: false,
      brand: trimmed,
      error:
        "brand names must be 1-64 chars: letters, digits, dot, dash, underscore. Avoid spaces and special characters.",
    };
  }

  const brands = loadBrands();
  if (!brands.includes(trimmed)) brands.push(trimmed);
  saveBrands(brands);

  if (workspacePath) {
    const created = materializeBrand(resolve(workspacePath), trimmed);
    return { ok: true, brand: trimmed, created };
  }
  return { ok: true, brand: trimmed };
}

export function removeBrand(brand: string): { ok: boolean; brands: string[] } {
  const brands = loadBrands().filter((b) => b !== brand);
  saveBrands(brands);
  return { ok: true, brands };
}
