// Guards on the webview HTML: each piece below was added deliberately to fix a bug, and is
// easy to lose in an unrelated edit.
import * as path from 'path';

import {describe, expect, it} from 'vitest';

import {Uri} from './fakeVscode';
import {DOC_DIR, EXTENSION_DIR, openEditor} from './harness';

describe('webview HTML', () => {
  it('allows scripts and only the extension bundle, draw.io viewer and workspace folders', () => {
    const ws = path.resolve('/ws');
    const ed = openEditor('', {workspaceFolder: ws});
    expect(ed.panel.webview.options.enableScripts).toBe(true);
    expect(ed.panel.webview.options.localResourceRoots!.map((u) => u.fsPath)).toEqual([
      path.join(EXTENSION_DIR, 'out', 'webview'),
      path.join(EXTENSION_DIR, 'media', 'drawio'),
      ws,
    ]);
  });

  it('falls back to the document folder outside a workspace', () => {
    const ed = openEditor('');
    expect(ed.panel.webview.options.localResourceRoots!.at(-1)!.fsPath).toBe(DOC_DIR);
  });

  it('pins <base href> to the document folder so relative images resolve', () => {
    const {html} = openEditor('').panel.webview;
    expect(html).toContain(`<base href="https://webview.test${Uri.file(DOC_DIR).path}/" />`);
  });

  it('has a nonce-based CSP that every script tag carries ("unsafe-eval" is needed by draw.io)', () => {
    const {html} = openEditor('').panel.webview;
    const nonce = /script-src 'nonce-([A-Za-z0-9]{32})' 'unsafe-eval'/.exec(html)?.[1];
    expect(nonce).toBeDefined();
    expect(html).toContain(`default-src 'none'`);
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
  });

  it('allows inlined fonts (KaTeX is bundled as data: URIs)', () => {
    const {html} = openEditor('').panel.webview;
    expect(html).toMatch(/font-src [^;]*data:/);
  });

  it.each([
    '[data-qa="g-md-search-panel"]',
    '.g-help-mark__popover',
    '.g-md-image-tooltip-form',
    '.g-md-image-form',
    '[data-qa="g-md-image-settings-menu"]',
  ])('lifts the %s popup above the sticky toolbar', (marker) => {
    const {html} = openEditor('').panel.webview;
    expect(html).toContain(`div[data-floating-ui-placement]:has(${marker})`);
  });
});
