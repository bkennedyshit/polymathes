import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/polymath.cjs',
  platform: 'node',
  format: 'cjs',
  bundle: true,
  external: ['better-sqlite3', '@modelcontextprotocol/sdk'],
  banner: { js: '#!/usr/bin/env node' },
  define: { 'import.meta.url': '__filename' },
});
