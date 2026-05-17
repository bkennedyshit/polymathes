import pino from 'pino';
import { mkdirSync, createWriteStream, existsSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { Writable } from 'node:stream';
import type { AppConfig } from './config/schema.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

const ROTATE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const KEEP_FILES = 3;

/**
 * Lightweight self-rotating file stream — no external dep.
 *
 * Wraps createWriteStream on the active log file. Before each chunk, checks
 * the current file's size. When it crosses ROTATE_SIZE_BYTES, rotates:
 *   gateway.log.2 → drop
 *   gateway.log.1 → gateway.log.2
 *   gateway.log   → gateway.log.1
 *   gateway.log   → fresh write stream
 *
 * Rotation runs synchronously inside _write so we never lose log lines
 * mid-rotation. At a few KB/sec of structured logs the size check is in
 * the noise.
 */
class RotatingFileStream extends Writable {
  private currentStream: ReturnType<typeof createWriteStream>;
  private bytesWritten = 0;

  constructor(private filePath: string) {
    super({ decodeStrings: false });
    // Track existing size so we don't immediately rotate a near-full file.
    if (existsSync(filePath)) {
      try { this.bytesWritten = statSync(filePath).size; } catch { /* */ }
    }
    this.currentStream = createWriteStream(filePath, { flags: 'a' });
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (err?: Error | null) => void,
  ): void {
    const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
    if (this.bytesWritten + len > ROTATE_SIZE_BYTES) {
      try { this.rotate(); }
      catch (e) { /* if rotation fails, keep writing to the current file */ }
    }
    this.currentStream.write(chunk, encoding, (err) => {
      if (!err) this.bytesWritten += len;
      callback(err ?? null);
    });
  }

  override _final(callback: (err?: Error | null) => void): void {
    this.currentStream.end(callback);
  }

  private rotate(): void {
    // Close the current stream first so Windows lets us rename.
    try { this.currentStream.end(); } catch { /* */ }

    // Shift older numbered files down: .2 → drop, .1 → .2, current → .1
    for (let i = KEEP_FILES - 1; i >= 1; i--) {
      const src = `${this.filePath}.${i}`;
      const dst = `${this.filePath}.${i + 1}`;
      if (existsSync(src)) {
        try {
          if (existsSync(dst)) unlinkSync(dst);
          renameSync(src, dst);
        } catch { /* best effort */ }
      }
    }
    if (existsSync(this.filePath)) {
      try { renameSync(this.filePath, `${this.filePath}.1`); } catch { /* */ }
    }

    this.currentStream = createWriteStream(this.filePath, { flags: 'a' });
    this.bytesWritten = 0;
  }
}

// pino.multistream runs in-process — no worker threads, so it survives the
// esbuild CJS bundle (which breaks pino.transport worker resolution).
export function createLogger(config: Pick<AppConfig, 'runtime'>) {
  const logDir = resolve(expandHome(config.runtime.home_dir), 'logs');
  mkdirSync(logDir, { recursive: true });
  const logFile = resolve(logDir, 'gateway.log');

  const streams: pino.StreamEntry[] = [
    {
      level: config.runtime.log_level as pino.Level,
      stream: new RotatingFileStream(logFile),
    },
  ];

  if (process.stdout.isTTY) {
    streams.push({ level: config.runtime.log_level as pino.Level, stream: process.stdout });
  }

  return pino({ level: config.runtime.log_level }, pino.multistream(streams));
}
