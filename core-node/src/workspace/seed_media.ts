/**
 * Media seed — walk a directory tree, classify each video/photo/audio
 * file via path-inference, extract metadata via ffprobe (videos) or
 * lightweight image headers, and upsert each into MediaEpisodic.
 *
 * Idempotent: re-running over the same tree updates rows in place. Files
 * that haven't changed (same mtime + size) skip the metadata pass to
 * keep re-seeds fast.
 *
 * Skips the heavy lifting (ffprobe, hash) on large files unless
 * --force-large is set, consistent with the C++ indexer's guardrails.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, statSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { inferFromPath, loadPathRules, type PathRulesConfig } from "../memory/path_inference.js";
import type { MediaEpisodic, MediaItem } from "../memory/media_episodic.js";

export interface SeedOptions {
  /** Paths under this size threshold get hashed + ffprobed. */
  maxFileMb?: number;       // default 2048 MB (2 GB)
  /** Videos longer than this get warnings (still indexed). */
  maxVideoMinutes?: number; // default 10
  /** Bypass size/duration guardrails. */
  forceLarge?: boolean;
  /** Only process files modified after this ISO timestamp. */
  since?: string;
  /** Don't write anything, just print what would happen. */
  dryRun?: boolean;
  /** Per-batch transaction size when committing to SQLite. */
  batchSize?: number;       // default 500
  onProgress?: (event: SeedProgressEvent) => void;
  /**
   * Optional hook invoked for each text file (.md/.txt/.rst) registered.
   * Lets the caller embed the file's content into semantic memory so the
   * agent can RAG over notes/blogs. Receives the absolute path, the raw
   * UTF-8 content, and the inferred brand. Errors are swallowed so a bad
   * embed doesn't abort the seed.
   */
  onText?: (info: { path: string; content: string; brand: string | null | undefined }) => Promise<void> | void;
}

export interface SeedProgressEvent {
  type: "scan" | "classify" | "skip" | "register" | "done";
  path?: string;
  reason?: string;
  count?: number;
}

export interface SeedResult {
  total_files: number;
  registered: number;
  skipped: number;
  by_brand: Record<string, number>;
  by_category: Record<string, number>;
  warnings: string[];
  duration_ms: number;
  dry_run: boolean;
}

const VIDEO_EXTS = new Set([
  ".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".wmv", ".flv", ".mpg", ".mpeg",
]);
const IMAGE_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".tiff", ".tif", ".bmp",
]);
const AUDIO_EXTS = new Set([
  ".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac", ".opus",
]);
const TEXT_EXTS = new Set([
  ".md", ".markdown", ".txt", ".rst",
]);

function classifyKind(absPath: string): "video" | "image" | "audio" | "text" | null {
  const ext = extname(absPath).toLowerCase();
  if (VIDEO_EXTS.has(ext)) return "video";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (TEXT_EXTS.has(ext)) return "text";
  return null;
}

/**
 * Cheap perceptual hash: md5 of first 64KB + last 64KB. Catches dupes
 * across copies/moves; not cryptographic. Skips on read errors.
 */
function quickHash(absPath: string, size: number): string | undefined {
  const CHUNK = 64 * 1024;
  try {
    const h = createHash("md5");
    const fd = openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(CHUNK);
      const headBytes = readSync(fd, buf, 0, Math.min(CHUNK, size), 0);
      h.update(buf.subarray(0, headBytes));
      if (size > CHUNK * 2) {
        const tailStart = Math.max(0, size - CHUNK);
        const tailBytes = readSync(fd, buf, 0, CHUNK, tailStart);
        h.update(buf.subarray(0, tailBytes));
      }
      h.update(String(size));
      return h.digest("hex");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

interface FfprobeResult {
  duration_sec?: number;
  width?: number;
  height?: number;
  aspect_ratio?: number;
  codec?: string;
  bitrate?: number;
}

function ffprobe(absPath: string): FfprobeResult {
  const args = [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    absPath,
  ];
  const proc = spawnSync("ffprobe", args, { encoding: "utf-8", timeout: 8000 });
  if (proc.status !== 0 || !proc.stdout) return {};
  try {
    const json = JSON.parse(proc.stdout);
    const video = (json.streams ?? []).find((s: any) => s.codec_type === "video");
    const result: FfprobeResult = {};
    const dur = parseFloat(json.format?.duration);
    if (!isNaN(dur)) result.duration_sec = dur;
    const br = parseInt(json.format?.bit_rate, 10);
    if (!isNaN(br)) result.bitrate = br;
    if (video) {
      if (video.width) result.width = Number(video.width);
      if (video.height) result.height = Number(video.height);
      if (video.codec_name) result.codec = video.codec_name;
      if (result.width && result.height) {
        result.aspect_ratio = Number((result.width / result.height).toFixed(4));
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Read width/height from common image format headers without pulling
 * sharp/exifr. Best-effort — falls back to undefined if format unknown.
 */
function imageDimensions(absPath: string): { width?: number; height?: number } {
  try {
    const fd = openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(64);
      readSync(fd, buf, 0, 64, 0);
      // PNG: signature + IHDR width/height
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        const width = buf.readUInt32BE(16);
        const height = buf.readUInt32BE(20);
        return { width, height };
      }
      // JPEG: scan SOF markers (best-effort). Skipped to avoid false data.
      // GIF: 6-byte sig + 2 bytes width + 2 bytes height (LE)
      if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
        const width = buf.readUInt16LE(6);
        const height = buf.readUInt16LE(8);
        return { width, height };
      }
      // WEBP: "RIFF....WEBP" then VP8 chunks (skip — 30+ LOC)
    } finally {
      closeSync(fd);
    }
  } catch { /* ignore */ }
  return {};
}

function shouldSkipBySize(
  size: number,
  maxFileMb: number,
  forceLarge: boolean,
): boolean {
  if (forceLarge) return false;
  return size > maxFileMb * 1024 * 1024;
}

function* walk(rootPath: string, ruleSet: PathRulesConfig, since?: number): Generator<{
  path: string;
  size: number;
  mtimeMs: number;
}> {
  // Use a manual stack so we can prune skip-paths before descending.
  const stack: string[] = [rootPath];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      // Quick prune: skip well-known non-content subtrees.
      const inferLite = inferFromPath(full + (entry.isDirectory() ? "/" : ""), ruleSet);
      if (inferLite.skipped) continue;

      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const stat = statSync(full);
          if (since && stat.mtimeMs < since) continue;
          yield { path: full, size: stat.size, mtimeMs: stat.mtimeMs };
        } catch { /* unreadable — skip */ }
      }
    }
  }
}

export async function seedMedia(
  rootPath: string,
  episodic: MediaEpisodic,
  opts: SeedOptions = {},
): Promise<SeedResult> {
  const start = Date.now();
  const ruleSet = loadPathRules();
  const root = resolve(rootPath);

  if (!existsSync(root)) {
    return {
      total_files: 0,
      registered: 0,
      skipped: 0,
      by_brand: {},
      by_category: {},
      warnings: [`path does not exist: ${root}`],
      duration_ms: Date.now() - start,
      dry_run: opts.dryRun ?? false,
    };
  }

  const maxFileMb = opts.maxFileMb ?? 2048;
  const maxVideoMinutes = opts.maxVideoMinutes ?? 10;
  const forceLarge = opts.forceLarge ?? false;
  const sinceMs = opts.since ? new Date(opts.since).getTime() : undefined;

  // Load brand-override file once. Lets `polymath media retag` corrections
  // survive a re-seed without re-walking.
  const overridesPath = join(homedir(), ".polymath", "brand-overrides.json");
  let overrides: Record<string, { brand?: string; category?: string; intent?: string }> = {};
  if (existsSync(overridesPath)) {
    try { overrides = JSON.parse(readFileSync(overridesPath, "utf-8")); }
    catch { overrides = {}; }
  }

  let total = 0;
  let registered = 0;
  let skipped = 0;
  const byBrand: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const warnings: string[] = [];

  for (const { path: absPath, size, mtimeMs } of walk(root, ruleSet, sinceMs)) {
    total++;
    opts.onProgress?.({ type: "scan", path: absPath });

    const kind = classifyKind(absPath);
    if (!kind) {
      skipped++;
      opts.onProgress?.({ type: "skip", path: absPath, reason: "unsupported extension" });
      continue;
    }

    const inferred = inferFromPath(absPath, ruleSet);
    if (inferred.skipped) {
      skipped++;
      opts.onProgress?.({ type: "skip", path: absPath, reason: inferred.skip_reason });
      continue;
    }

    // Apply per-path overrides if the user has retagged this file.
    const override = overrides[absPath];
    const finalBrand = override?.brand ?? inferred.brand;
    const finalCategory = override?.category ?? inferred.category;
    const finalIntent = override?.intent ?? inferred.intent;

    if (shouldSkipBySize(size, maxFileMb, forceLarge)) {
      skipped++;
      const sizeMb = Math.round(size / 1024 / 1024);
      warnings.push(
        `skipped large file (${sizeMb}MB > ${maxFileMb}MB): ${absPath} — pass --force-large to override`,
      );
      opts.onProgress?.({ type: "skip", path: absPath, reason: "too large" });
      continue;
    }

    // Heavy metadata pass (only on files we're actually going to register).
    let meta: FfprobeResult & { width?: number; height?: number } = {};
    if (kind === "video") {
      meta = ffprobe(absPath);
      if (
        meta.duration_sec &&
        meta.duration_sec > maxVideoMinutes * 60 &&
        !forceLarge
      ) {
        warnings.push(
          `long video (${Math.round(meta.duration_sec / 60)}m > ${maxVideoMinutes}m): ${absPath}`,
        );
      }
    } else if (kind === "image") {
      meta = imageDimensions(absPath);
    }

    const sourceHash = quickHash(absPath, size);
    const modifiedAt = new Date(mtimeMs).toISOString();

    const item: Omit<MediaItem, "id" | "indexed_at"> = {
      path: absPath,
      kind,
      brand: finalBrand,
      category: finalCategory,
      intent: finalIntent,
      duration_sec: meta.duration_sec,
      width: meta.width,
      height: meta.height,
      aspect_ratio: meta.aspect_ratio,
      file_size_bytes: size,
      modified_at: modifiedAt,
      source_hash: sourceHash,
      metadata: {
        ...inferred.metadata,
        ...(meta.codec ? { codec: meta.codec } : {}),
        ...(meta.bitrate ? { bitrate: String(meta.bitrate) } : {}),
        ...(inferred.workflow_state ? { workflow_state: inferred.workflow_state } : {}),
        ...(inferred.warn_on_edit ? { warn_on_edit: "true" } : {}),
        ...(override ? { retagged: "true" } : {}),
      },
    };

    if (!opts.dryRun) {
      episodic.upsert(item);
    }

    // For text files, hand the content to the embedding hook so the
    // caller can fold it into semantic memory for RAG. Best-effort —
    // we read up to 256KB to avoid loading huge files into memory.
    if (kind === "text" && opts.onText && !opts.dryRun) {
      try {
        const fd = openSync(absPath, "r");
        try {
          const cap = Math.min(size, 256 * 1024);
          const buf = Buffer.alloc(cap);
          const n = readSync(fd, buf, 0, cap, 0);
          const content = buf.subarray(0, n).toString("utf-8");
          if (content.trim()) {
            await opts.onText({ path: absPath, content, brand: finalBrand });
          }
        } finally {
          closeSync(fd);
        }
      } catch { /* embedding is best-effort */ }
    }

    registered++;
    byBrand[finalBrand ?? "(unbranded)"] =
      (byBrand[finalBrand ?? "(unbranded)"] ?? 0) + 1;
    byCategory[finalCategory ?? "(uncategorized)"] =
      (byCategory[finalCategory ?? "(uncategorized)"] ?? 0) + 1;

    opts.onProgress?.({ type: "register", path: absPath });
  }

  opts.onProgress?.({ type: "done", count: registered });

  return {
    total_files: total,
    registered,
    skipped,
    by_brand: byBrand,
    by_category: byCategory,
    warnings,
    duration_ms: Date.now() - start,
    dry_run: opts.dryRun ?? false,
  };
}
