import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { AppConfig } from './config/schema.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

export function createLogger(config: Pick<AppConfig, 'runtime'>) {
  const logDir = resolve(expandHome(config.runtime.home_dir), 'logs');
  mkdirSync(logDir, { recursive: true });
  const logFile = resolve(logDir, 'gateway.log');

  const targets: pino.TransportTargetOptions[] = [
    { target: 'pino/file', options: { destination: logFile }, level: config.runtime.log_level },
  ];

  if (process.stdout.isTTY) {
    targets.push({ target: 'pino-pretty', options: { colorize: true }, level: config.runtime.log_level });
  }

  return pino({ level: config.runtime.log_level }, pino.transport({ targets }));
}
