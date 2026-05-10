import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { AppConfigSchema, type AppConfig } from './schema.js';
import { defaults } from './defaults.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

function interpolateEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_, key) => {
      const v = process.env[key];
      if (v === undefined) throw new Error(`Missing environment variable: ${key}`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map(interpolateEnv);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateEnv(v);
    }
    return out;
  }
  return value;
}

export function loadConfig(path?: string): AppConfig {
  const configPath = path ?? resolve(expandHome('~/.polymath'), 'polymath.json');

  if (!existsSync(configPath)) {
    const dir = resolve(configPath, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(defaults, null, 2), 'utf-8');
    return defaults;
  }

  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  const interpolated = interpolateEnv(raw);
  return AppConfigSchema.parse(interpolated);
}
