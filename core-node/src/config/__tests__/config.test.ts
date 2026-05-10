import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../load.js';
import { AppConfigSchema } from '../schema.js';
import { defaults } from '../defaults.js';

const tmp = resolve(tmpdir(), 'polymath-test-config-' + process.pid);

beforeEach(() => mkdirSync(tmp, { recursive: true }));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('config', () => {
  it('loads valid config', () => {
    const file = resolve(tmp, 'polymath.json');
    writeFileSync(file, JSON.stringify(defaults));
    const cfg = loadConfig(file);
    expect(cfg.runtime.port).toBe(18789);
    expect(cfg.llm.model).toBe('gpt-4o');
  });

  it('writes default template on missing file', () => {
    const file = resolve(tmp, 'sub', 'polymath.json');
    const cfg = loadConfig(file);
    expect(cfg).toEqual(defaults);
  });

  it('interpolates ${ENV} variables', () => {
    process.env['TEST_API_KEY'] = 'sk-secret';
    const file = resolve(tmp, 'env.json');
    writeFileSync(file, JSON.stringify({ ...defaults, llm: { ...defaults.llm, api_key: '${TEST_API_KEY}' } }));
    const cfg = loadConfig(file);
    expect(cfg.llm.api_key).toBe('sk-secret');
    delete process.env['TEST_API_KEY'];
  });

  it('throws on missing env variable', () => {
    delete process.env['NONEXISTENT_VAR'];
    const file = resolve(tmp, 'bad-env.json');
    writeFileSync(file, JSON.stringify({ ...defaults, llm: { ...defaults.llm, api_key: '${NONEXISTENT_VAR}' } }));
    expect(() => loadConfig(file)).toThrow('Missing environment variable: NONEXISTENT_VAR');
  });

  it('rejects invalid config', () => {
    const file = resolve(tmp, 'invalid.json');
    writeFileSync(file, JSON.stringify({ runtime: { log_level: 'banana' } }));
    expect(() => loadConfig(file)).toThrow();
  });
});
