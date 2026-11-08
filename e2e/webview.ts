// Loads the real webview (built bundle + the extension's own HTML, CSP included) in a page and
// plays the extension host's part over the message protocol.
import * as fs from 'fs';
import * as path from 'path';

import {expect, type Page} from '@playwright/test';

import type {ExtensionMessage, WebviewMessage} from '../src/webview-protocol';
import {buildWebviewHtml} from '../src/webviewHtml';

const ROOT = path.resolve(__dirname, '..');
export const ORIGIN = 'https://gravity.test';
const NONCE = 'e2eNonce0123456789abcdefABCDEF01';

type ConfigMessage = Extract<ExtensionMessage, {type: 'config'}>;

export const DEFAULT_CONFIG: ConfigMessage = {
  type: 'config',
  fontFamily: '',
  monospaceFontFamily: '',
  fontSize: 0,
  monospaceFontSize: 0,
  theme: 'light',
  preserveEmptyLines: true,
  defaultMode: 'wysiwyg',
  preserveMarkupFormatting: false,
  newTableFormat: 'gfm',
  enableSlashCommands: true,
  drawioAutoFitWidth: true,
};

// Stands in for VS Code's acquireVsCodeApi and records what the webview posts. Also records
// CSP violations, which would otherwise only show up as console noise.
const HOST_STUB = `
window.__posted = [];
window.__cspViolations = [];
document.addEventListener('securitypolicyviolation', (e) => {
  window.__cspViolations.push(e.violatedDirective + ' ' + e.blockedURI);
});
window.acquireVsCodeApi = () => ({
  postMessage: (m) => { window.__posted.push(JSON.parse(JSON.stringify(m))); },
  getState: () => undefined,
  setState: () => {},
});`;

declare global {
  interface Window {
    __posted: WebviewMessage[];
    __cspViolations: string[];
  }
}

export interface OpenOptions {
  config?: Partial<ConfigMessage>;
  /** Folder (relative to the repo root) the document lives in; relative images resolve against it. */
  docFolder?: string;
}

export async function openEditor(page: Page, text: string, opts: OpenOptions = {}) {
  const docFolder = opts.docFolder ?? 'e2e/fixtures';
  const html = buildWebviewHtml({
    cspSource: ORIGIN,
    scriptUri: `${ORIGIN}/out/webview/main.js`,
    viewerJsUri: `${ORIGIN}/media/drawio/viewer-static.min.js`,
    baseHref: `${ORIGIN}/${docFolder}/`,
    nonce: NONCE,
  }).replace('<script nonce=', `<script nonce="${NONCE}">${HOST_STUB}</script>\n  <script nonce=`);

  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // Serve the repo from the fake origin; nothing else is reachable.
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === '/index.html') return route.fulfill({contentType: 'text/html', body: html});
    const file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return route.fulfill({status: 404, body: 'not found'});
    }
    return route.fulfill({path: file});
  });

  await page.goto(`${ORIGIN}/index.html`);
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'ready'));

  const send = (msg: ExtensionMessage) => page.evaluate((m) => window.postMessage(m, '*'), msg);
  const config: ConfigMessage = {...DEFAULT_CONFIG, ...opts.config};
  await send({type: 'update', text, docDir: path.join(ROOT, docFolder)});
  await send(config);

  const editor = page.locator(config.defaultMode === 'markup' ? '.cm-content' : '.ProseMirror').first();
  await expect(editor).toBeVisible();

  let flushId = 0;
  const wv = {
    page,
    editor,
    pageErrors,
    send,

    posted: () => page.evaluate(() => window.__posted),
    postedOf: async <T extends WebviewMessage['type']>(type: T) =>
      (await wv.posted()).filter((m): m is Extract<WebviewMessage, {type: T}> => m.type === type),
    cspViolations: () => page.evaluate(() => window.__cspViolations),

    /** Ask for the current content, as the extension does at save time; returns the serialized text. */
    async flush(): Promise<string> {
      const id = ++flushId + 1000;
      await send({type: 'requestFlush', id});
      const handle = await page.waitForFunction(
        (wanted) => window.__posted.find((m) => m.type === 'flushResponse' && m.id === wanted),
        id,
      );
      const msg = (await handle.jsonValue()) as Extract<WebviewMessage, {type: 'flushResponse'}>;
      return msg.text;
    },
  };
  return wv;
}

/** Load `text` into a fresh editor and return what the editor serializes it back to. */
export async function roundTrip(page: Page, text: string, opts?: OpenOptions): Promise<string> {
  const wv = await openEditor(page, text, opts);
  return wv.flush();
}

export function readRepoFile(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}
