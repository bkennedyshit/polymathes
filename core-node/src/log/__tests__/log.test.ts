import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '../../log.js';

const tmp = resolve(tmpdir(), 'polymath-test-log-' + process.pid);

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('logger', () => {
  it('creates a pino logger instance', () => {
    const logger = createLogger({ runtime: { home_dir: tmp, port: 0, log_level: 'info' } });
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
  });

  it('supports child loggers', () => {
    const logger = createLogger({ runtime: { home_dir: tmp, port: 0, log_level: 'debug' } });
    const child = logger.child({ subsystem: 'orchestrator' });
    expect(child).toBeDefined();
    expect(typeof child.info).toBe('function');
  });
});
