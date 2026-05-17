/**
 * Path-inference engine — turns absolute file paths into structured metadata
 * the agent can reason about: brand, category, intent, plus free-form
 * metadata extracted from the path's segments.
 *
 * This is the brain of the framework's "RetroArch convention." Users adopt
 * the layout (`input/<brand>/`, `content/<brand>/reels/`, etc.) and the
 * agent automatically understands where everything fits. No hardcoded
 * brand names — the convention is pattern-based.
 *
 * Rules ship as `templates/path-rules.json` and can be extended by users
 * via `~/.polymath/path-rules.json` (deep-merged at runtime).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export interface PathInferenceRule {
  /**
   * Glob-like pattern with `<brand>` and `<category>` capture variables.
   * Matched against forward-slash-normalized lowercase paths.
   * Examples:
   *   "input/<brand>/raw/"
   *   "content/<brand>/reels/"
   *   "content/pinterest/<pin_type>/"
   */
  match: string;
  brand?: string;          // literal brand if path locks one in
  category?: string;
  intent?: string;
  workflow_state?: string;
  warn_on_edit?: boolean;
  /** Variables whose captures get copied into metadata. */
  metadata?: Record<string, string>;
}

export interface PathRulesConfig {
  version: number;
  rules: PathInferenceRule[];
  skip_paths?: string[];           // path fragments that mean "don't index"
  brand_aliases?: Record<string, string>;  // canonicalize variants
}

export interface InferredPath {
  brand?: string;
  category?: string;
  intent?: string;
  workflow_state?: string;
  warn_on_edit?: boolean;
  metadata: Record<string, string>;
  matched_rule?: string;
  skipped?: boolean;
  skip_reason?: string;
}

/**
 * Default rules baked into the binary. Real shipped config lives at
 * `templates/path-rules.json` next to the binary; this is the safety net
 * for when that file is missing.
 *
 * IMPORTANT: NO brand names hardcoded. <brand> is a pattern variable,
 * not a default value.
 */
const DEFAULT_RULES: PathRulesConfig = {
  version: 1,
  rules: [
    // ─── Input — raw material for the agent to work on. ───────────────
    { match: "input/<brand>/raw/", category: "raw", intent: "agent-input" },
    { match: "input/<brand>/fixed/", category: "color-corrected", intent: "agent-input" },
    { match: "input/<brand>/", category: "raw", intent: "agent-input" },

    // ─── Content — order matters: most specific (platform/category dirs)
    // BEFORE generic <brand> capture, otherwise "pinterest" gets captured
    // as a brand. ──────────────────────────────────────────────────────

    // Pinterest is a platform, not a brand.
    {
      match: "content/pinterest/<pin_type>/",
      category: "pin",
      metadata: { pin_type: "$pin_type", platform: "pinterest" },
    },
    {
      match: "content/pinterest/",
      category: "pin",
      metadata: { platform: "pinterest" },
    },

    // Blog images — audience-tagged, not brand-specific.
    {
      match: "content/blog-images/<audience>/",
      category: "blog-image",
      metadata: { audience: "$audience" },
    },
    { match: "content/blog-images/", category: "blog-image" },

    // AI-generated — flat dir, no brand.
    { match: "content/generated-images/", category: "ai-generated" },

    // OBS captures — raw screen recordings, treat like input.
    {
      match: "content/obs-recordings/",
      category: "raw-recording",
      intent: "agent-input",
    },

    // Now the brand-keyed content categories. <brand> here will only
    // match dirs not matched above.
    {
      match: "content/<brand>/reels/",
      category: "reel",
      workflow_state: "ready-to-post",
      warn_on_edit: true,
    },
    { match: "content/<brand>/long-form/", category: "long-form" },
    { match: "content/<brand>/static/", category: "static-image" },
    { match: "content/<brand>/static-images/", category: "static-image" },
    {
      match: "content/<brand>/talking-head/",
      category: "long-form",
      metadata: { format: "talking-head" },
    },
    { match: "content/<brand>/", category: "edited" },

    // ─── Non-content: agent output / archives / scripts / music. ──────
    { match: "output/", category: "agent-output" },
    { match: "cuts/", category: "clip" },
    { match: "archive/<brand>/", category: "archive" },
    { match: "archive/", category: "archive" },
    { match: "content-music/", category: "stock-asset", metadata: { kind_hint: "audio" } },
    { match: "video-scripts/", category: "script", metadata: { kind_hint: "text" } },
  ],
  skip_paths: [
    "agent_brain/",
    "skills/",
    ".polymath/",
    "logs/",
    "projects-index/",
    "node_modules/",
    ".git/",
    ".kiro/",
  ],
  brand_aliases: {
    // Common normalization patterns. Users extend via override file.
  },
};

let cachedConfig: PathRulesConfig | null = null;

/**
 * Auto-locate `templates/path-rules.json` shipped alongside the binary.
 * Returns null if not found — callers fall back to DEFAULT_RULES baked
 * into this file.
 */
function findShippedRulesPath(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, "..", "..", "templates", "path-rules.json"),
      resolve(here, "..", "templates", "path-rules.json"),
      resolve(here, "templates", "path-rules.json"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  } catch { /* ignore — using bare DEFAULT_RULES is fine */ }
  return null;
}

/**
 * Load rules from disk. Order:
 *   1. Bundled `templates/path-rules.json` next to dist/polymath.cjs
 *   2. User override `~/.polymath/path-rules.json` (deep-merged on top)
 *   3. DEFAULT_RULES (fallback)
 */
export function loadPathRules(opts: {
  bundledPath?: string;
  userOverridePath?: string;
  forceReload?: boolean;
} = {}): PathRulesConfig {
  if (cachedConfig && !opts.forceReload) return cachedConfig;

  let config: PathRulesConfig = { ...DEFAULT_RULES, rules: [...DEFAULT_RULES.rules] };

  const shippedPath = opts.bundledPath ?? findShippedRulesPath();
  if (shippedPath && existsSync(shippedPath)) {
    try {
      const shipped = JSON.parse(readFileSync(shippedPath, "utf-8")) as PathRulesConfig;
      config = mergeConfigs(config, shipped);
    } catch { /* malformed shipped rules — fall through to defaults */ }
  }

  const userPath = opts.userOverridePath ?? join(homedir(), ".polymath", "path-rules.json");
  if (existsSync(userPath)) {
    try {
      const user = JSON.parse(readFileSync(userPath, "utf-8")) as PathRulesConfig;
      config = mergeConfigs(config, user);
    } catch { /* malformed user override — ignore */ }
  }

  cachedConfig = config;
  return config;
}

function mergeConfigs(base: PathRulesConfig, over: Partial<PathRulesConfig>): PathRulesConfig {
  return {
    version: over.version ?? base.version,
    rules: [...(over.rules ?? []), ...base.rules], // user rules first — first match wins
    skip_paths: [...new Set([...(base.skip_paths ?? []), ...(over.skip_paths ?? [])])],
    brand_aliases: { ...(base.brand_aliases ?? {}), ...(over.brand_aliases ?? {}) },
  };
}

/**
 * Normalize a path for matching: forward slashes, lowercase, trailing slash
 * preserved. We match against the path "as a tree position," not the file
 * basename.
 */
function normalize(absPath: string): string {
  let p = absPath.replace(/\\/g, "/").toLowerCase();
  if (!p.endsWith("/")) p += "/";  // pretend everything is a directory; we strip later
  return p;
}

/**
 * Convert a rule's `match` string into a regex. `<varname>` becomes a
 * capture group; everything else is escaped. Matches anywhere in the path
 * by default — anchored to start at any path segment boundary.
 */
function ruleToRegex(matchStr: string): { regex: RegExp; vars: string[] } {
  const vars: string[] = [];
  // Escape regex specials except our angle-bracket placeholders.
  const escaped = matchStr
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/<([a-z_]+)>/g, (_m, name) => {
      vars.push(name);
      return "([^/]+)";
    });
  // Match the rule anywhere after a path separator (or at start).
  const regex = new RegExp(`(?:^|/)${escaped}`, "i");
  return { regex, vars };
}

/**
 * Apply path-inference rules to an absolute file path. Returns inferred
 * brand/category/intent/metadata, or {skipped: true} if the path matches a
 * skip rule.
 */
export function inferFromPath(absPath: string, config?: PathRulesConfig): InferredPath {
  const cfg = config ?? loadPathRules();
  const normalized = normalize(absPath);

  // Skip-paths short-circuit before any rule matching.
  for (const skip of cfg.skip_paths ?? []) {
    if (normalized.includes(skip.toLowerCase())) {
      return {
        metadata: {},
        skipped: true,
        skip_reason: `path contains skip pattern: ${skip}`,
      };
    }
  }

  for (const rule of cfg.rules) {
    const { regex, vars } = ruleToRegex(rule.match);
    const m = normalized.match(regex);
    if (!m) continue;

    // Bind capture vars by name.
    const bound: Record<string, string> = {};
    vars.forEach((v, i) => { bound[v] = m[i + 1] ?? ""; });

    // Build metadata: literal pairs from rule + variable substitutions.
    const metadata: Record<string, string> = {};
    if (rule.metadata) {
      for (const [k, v] of Object.entries(rule.metadata)) {
        if (typeof v === "string" && v.startsWith("$")) {
          metadata[k] = bound[v.slice(1)] ?? "";
        } else {
          metadata[k] = v;
        }
      }
    }

    // Brand: explicit literal first, captured `<brand>` var second.
    let brand = rule.brand ?? bound.brand;
    if (brand && cfg.brand_aliases?.[brand]) {
      brand = cfg.brand_aliases[brand];
    }

    return {
      brand: brand || undefined,
      category: rule.category,
      intent: rule.intent,
      workflow_state: rule.workflow_state,
      warn_on_edit: rule.warn_on_edit,
      metadata,
      matched_rule: rule.match,
    };
  }

  return { metadata: {} };
}

/** Reset cached config (used in tests). */
export function _resetPathRulesCache(): void {
  cachedConfig = null;
}
