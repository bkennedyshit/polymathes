/**
 * Token store for the Codex (ChatGPT subscription) auth flow.
 *
 * On-disk location: `<polymath_home>/codex-auth.json` (file mode 0600).
 * `polymath_home` resolves to `$POLYMATH_HOME` when set, otherwise
 * `~/.polymath` — matching how the rest of the core-node codebase
 * resolves the home directory (see `src/db/open.ts`,
 * `src/gateway/auth.ts`, etc.).
 *
 * Writes are atomic: we write to a sibling tmp file and `rename()` it
 * into place so a crashed process can never leave a half-written
 * `codex-auth.json` that breaks subsequent loads.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CodexAuthStored } from "./responses_protocol.js";

const FILE_NAME = "codex-auth.json";
const IS_WINDOWS = process.platform === "win32";

/**
 * Resolve the polymath home directory. Honours `POLYMATH_HOME` for tests
 * and unusual deployments; falls back to `~/.polymath` to match the
 * convention used elsewhere in the codebase.
 */
function getPolymathHome(): string {
  const override = process.env.POLYMATH_HOME;
  if (override && override.trim()) return override;
  return join(homedir(), ".polymath");
}

function getAuthPath(): string {
  return join(getPolymathHome(), FILE_NAME);
}

/**
 * Best-effort chmod. On Windows, POSIX file modes are meaningless and
 * `fs.chmodSync` is a no-op for non-readonly bits — but it should not
 * throw. We swallow errors so a Windows test environment doesn't break
 * when ACLs reject the call.
 */
function safeChmod(path: string, mode: number): void {
  if (IS_WINDOWS) {
    // chmod is a no-op for permission bits on Windows. Calling it is
    // harmless but we avoid surprises by skipping entirely.
    return;
  }
  try {
    chmodSync(path, mode);
  } catch {
    // Filesystems that don't support chmod (some network mounts) — don't
    // fail the save just because we couldn't lock down the mode.
  }
}

/**
 * Read the stored auth payload. Returns `null` if the file does not
 * exist; throws if the file exists but cannot be parsed (callers that
 * want to recover from a corrupted store should catch and call
 * `wipeAuth()` themselves).
 */
export async function loadAuth(): Promise<CodexAuthStored | null> {
  const path = getAuthPath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as CodexAuthStored;
}

/**
 * Atomically persist the auth payload. Creates `<polymath_home>` if it
 * doesn't exist, writes to a tmp sibling file with mode 0600, then
 * renames into place. The rename is atomic on every OS we target so a
 * concurrent reader sees either the old file or the new file, never a
 * truncated one.
 */
export async function saveAuth(auth: CodexAuthStored): Promise<void> {
  const dir = getPolymathHome();
  mkdirSync(dir, { recursive: true });

  const finalPath = getAuthPath();
  // Distinct tmp name per call so two concurrent saves don't clobber
  // each other's tmp file before rename.
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;

  const payload = JSON.stringify(auth, null, 2);
  writeFileSync(tmpPath, payload, { mode: 0o600 });
  safeChmod(tmpPath, 0o600);

  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    // Clean up the tmp file if the rename failed for any reason —
    // otherwise we leak garbage into ~/.polymath/.
    try { unlinkSync(tmpPath); } catch { /* swallow */ }
    throw err;
  }

  // Re-apply mode after rename — on some filesystems rename can reset
  // bits. Cheap insurance.
  safeChmod(finalPath, 0o600);
}

/**
 * Delete the auth file if present. No-op (no error) when the file is
 * already absent so the CLI's `polymath llm logout` is idempotent.
 */
export async function wipeAuth(): Promise<void> {
  const path = getAuthPath();
  if (!existsSync(path)) return;
  unlinkSync(path);
}
