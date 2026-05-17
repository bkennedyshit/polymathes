import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '../../log.js';
import type pino from 'pino';

const tmp = resolve(tmpdir(), 'polymath-test-log-' + process.pid);

// Track loggers across tests so we can flush+close their write streams
// before the temp dir is removed. Without this, an in-flight log line gets
// flushed by pino's internal queue AFTER rmSync has nuked the directory,
// throwing ENOENT on its hidden write — which surfaces as an unhandled
// exception (not a test failure) and exits the suite with code 1.
const loggers: pino.Logger[] = [];

afterEach(async () => {
  for (const lg of loggers.splice(0)) {
    try {
      // Flush pino's internal stream queue then close.
      lg.flush?.();
      // Give the event loop one tick so any pending fs write completes.
      await new Promise((r) => setImmediate(r));
    } catch { /* best effort */ }
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('logger', () => {
  it('creates a pino logger instance', () => {
    const logger = createLogger({ runtime: { home_dir: tmp, port: 0, log_level: 'info' } });
    loggers.push(logger);
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
  });

  it('supports child loggers', () => {
    const logger = createLogger({ runtime: { home_dir: tmp, port: 0, log_level: 'debug' } });
    loggers.push(logger);
    const child = logger.child({ subsystem: 'orchestrator' });
    expect(child).toBeDefined();
    expect(typeof child.info).toBe('function');
  });
});
