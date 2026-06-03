import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/polymath.cjs',
  platform: 'node',
  format: 'cjs',
  bundle: true,
  external: ['better-sqlite3', 'playwright-core', 'chromium-bidi'],
  banner: {
    js: `#!/usr/bin/env node
const { pathToFileURL: __ptfu } = require('node:url');
const __importMetaUrl = __ptfu(__filename).href;`,
  },
  define: { 'import.meta.url': '__importMetaUrl' },
});

// Copy UI HTML next to the bundle so the gateway can serve it.
await mkdir('dist/ui', { recursive: true });
await cp('src/ui', 'dist/ui', { recursive: true });
console.log('build: copied src/ui/ -> dist/ui/');

// Cache-buster: stamp the build hash into the UI HTML <title> so cache-busted
// loads always see fresh markup. Hash is derived from the bundled CJS bytes
// — different code => different hash => browser fetches fresh HTML.
{
  const { createHash } = await import('node:crypto');
  const bundleBytes = await readFile('dist/polymath.cjs');
  const hash = createHash('sha1').update(bundleBytes).digest('hex').slice(0, 8);
  const htmlPath = 'dist/ui/index.html';
  let html = await readFile(htmlPath, 'utf-8');
  // Replace the title with one that includes the hash, AND insert a <meta>
  // build-id at the head so any future asset-fingerprinting can read it.
  html = html.replace(/<title>([^<]*)<\/title>/, `<title>$1 [${hash}]</title>`);
  html = html.replace(/<head>/, `<head>\n<meta name="polymath-build" content="${hash}"/>`);
  await writeFile(htmlPath, html, 'utf-8');
  console.log(`build: stamped UI with build hash ${hash}`);
}

// Copy templates next to the bundle so `polymath init` and the path-rules
// loader can find them at runtime regardless of cwd.
await mkdir('dist/templates', { recursive: true });
await cp('templates', 'dist/templates', { recursive: true });
console.log('build: copied templates/ -> dist/templates/');

// ---- Post-build patch: make node-fetch's AbortSignal check lenient. ----
// Telegraf 4.16 bundles node-fetch@2 which does a strict prototype check on
// AbortSignal that false-positives under Node 22 + CJS bundling. Replace the
// body of `isAbortSignal` with a duck-typed version. Safe no-op if the
// pattern isn't found (e.g. node-fetch version upgrades).
const bundlePath = 'dist/polymath.cjs';
let source = await readFile(bundlePath, 'utf-8');
const pattern = /function isAbortSignal\(signal\)\s*\{\s*const proto[^}]+\}/;
const replacement = 'function isAbortSignal(signal) {\n  return !!signal && typeof signal === "object" && "aborted" in signal && typeof signal.addEventListener === "function";\n}';
if (pattern.test(source)) {
  source = source.replace(pattern, replacement);
  await writeFile(bundlePath, source, 'utf-8');
  console.log('build: patched node-fetch isAbortSignal (Telegraf/Node22 compat)');
} else {
  console.log('build: isAbortSignal pattern not found — skipping patch');
}
