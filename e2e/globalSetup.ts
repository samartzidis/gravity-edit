// Fails the run up front if out/webview/main.js is missing or older than its sources, so the
// browser tests never silently run against a stale bundle after a webview edit.
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(ROOT, 'out', 'webview', 'main.js');

// Everything that ends up in the bundle (src/webview-protocol.ts is compiled into it too).
// src/webviewHtml.ts is not listed: the tests import it from source.
const SOURCES = [
  'webview-ui/src',
  'webview-ui/vite.config.ts',
  'webview-ui/package-lock.json',
  'src/webview-protocol.ts',
];

function newestFile(p: string): {file: string; mtime: number} | undefined {
  const stat = fs.statSync(p, {throwIfNoEntry: false});
  if (!stat) return undefined;
  if (!stat.isDirectory()) return {file: p, mtime: stat.mtimeMs};
  let newest: {file: string; mtime: number} | undefined;
  for (const entry of fs.readdirSync(p)) {
    const found = newestFile(path.join(p, entry));
    if (found && (!newest || found.mtime > newest.mtime)) newest = found;
  }
  return newest;
}

export default function globalSetup(): void {
  const bundle = fs.statSync(BUNDLE, {throwIfNoEntry: false});
  if (!bundle) {
    throw new Error('out/webview/main.js is missing - run `npm run build:all` before `npm run test:e2e`.');
  }
  for (const source of SOURCES) {
    const newest = newestFile(path.join(ROOT, source));
    if (newest && newest.mtime > bundle.mtimeMs) {
      throw new Error(
        `out/webview/main.js is older than ${path.relative(ROOT, newest.file)} - ` +
        'run `npm run build:all` (or `npm run build:webview`) so the browser tests use your current code.');
    }
  }
}
