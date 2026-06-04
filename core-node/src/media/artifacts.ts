import { extname } from "node:path";

export type MediaArtifactKind = "image" | "video" | "audio";

const MEDIA_PATH_RE = /(?:[A-Za-z]:\\|\\\\)[^\n\r"'<>`]+?\.(?:png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov|m4v|avi|mkv|mp3|wav|m4a)\b/gi;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a"]);

export interface MediaArtifact {
  path: string;
  kind: MediaArtifactKind;
}

export function mediaArtifactKind(path: string): MediaArtifactKind | null {
  const ext = extname(path).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return null;
}

export function extractMediaArtifacts(text: string, limit = 6): MediaArtifact[] {
  const matches = text.match(MEDIA_PATH_RE) ?? [];
  const seen = new Set<string>();
  const out: MediaArtifact[] = [];

  for (const raw of matches) {
    const path = raw.trim().replace(/[),.;:]+$/, "");
    const key = path.toLowerCase();
    if (seen.has(key)) continue;

    const kind = mediaArtifactKind(path);
    if (!kind) continue;

    seen.add(key);
    out.push({ path, kind });
    if (out.length >= limit) break;
  }

  return out;
}
