// Sanity checks on the build output, run after `npm run build:all`.
// Each check guards against a bug that once shipped with a clean build (see the messages).
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(root, p);

const MAX_BUNDLE_BYTES = 12 * 1024 * 1024;

const failures = [];
const fail = (msg) => failures.push(msg);

for (const f of ['out/extension.js', 'out/webview/main.js']) {
  if (!fs.existsSync(rel(f))) fail(`${f} is missing - run \`npm run build:all\` first.`);
}

// Vite prefers vite.config.js over vite.config.ts, so a stray .js copy silently makes
// every edit to the .ts config a no-op.
if (fs.existsSync(rel('webview-ui/vite.config.js'))) {
  fail('webview-ui/vite.config.js exists and shadows vite.config.ts - delete it.');
}

const bundlePath = rel('out/webview/main.js');
if (fs.existsSync(bundlePath)) {
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  const size = Buffer.byteLength(bundle);

  // CSS is injected from JS, so a root-absolute url() resolves against the document's
  // <base href> (the markdown file's folder) and 404s - fonts must be inlined instead.
  const rootAbsolute = bundle.match(/url\(\s*["']?\/[^/][^)]{0,60}/g) ?? [];
  if (rootAbsolute.length > 0) {
    fail(`out/webview/main.js has ${rootAbsolute.length} root-absolute url() reference(s), which 404 in the webview ` +
      `(assets must be inlined, see assetsInlineLimit in webview-ui/vite.config.ts). First: ${rootAbsolute[0]}`);
  }

  const fontUris = bundle.match(/data:font\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g) ?? [];
  if (!fontUris.some((u) => u.startsWith('data:font/woff2'))) {
    fail('out/webview/main.js has no inlined woff2 fonts - KaTeX fonts are expected as data: URIs.');
  }

  // Importing a second copy of the KaTeX CSS (e.g. '@diplodoc/latex-extension/runtime/styles')
  // inlines every font twice.
  const seen = new Set();
  let duplicates = 0;
  for (const uri of fontUris) {
    const hash = createHash('sha1').update(uri).digest('hex');
    if (seen.has(hash)) duplicates++;
    seen.add(hash);
  }
  if (duplicates > 0) {
    fail(`out/webview/main.js inlines ${duplicates} font(s) more than once - is a stylesheet imported twice?`);
  }

  if (size > MAX_BUNDLE_BYTES) {
    fail(`out/webview/main.js is ${(size / 1048576).toFixed(1)} MB, over the ${MAX_BUNDLE_BYTES / 1048576} MB limit.`);
  }

  if (failures.length === 0) {
    console.log(`out/webview/main.js: ${(size / 1048576).toFixed(1)} MB, ${fontUris.length} inlined font(s), no root-absolute url().`);
  }
}

if (failures.length > 0) {
  for (const msg of failures) console.error(`check:build FAILED: ${msg}`);
  process.exit(1);
}
console.log('check:build passed.');
