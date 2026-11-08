// The webview's HTML document. Kept free of the vscode API (callers pass resolved URIs as
// strings) so the Playwright tests in e2e/ can render exactly the same page in a browser.

export interface WebviewHtmlOptions {
  /** webview.cspSource */
  cspSource: string;
  /** Webview URI of out/webview/main.js */
  scriptUri: string;
  /** Webview URI of media/drawio/viewer-static.min.js */
  viewerJsUri: string;
  /** Webview URI of the document's folder, ending in '/' */
  baseHref: string;
  nonce: string;
}

export function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({length: 32}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export function buildWebviewHtml({cspSource, scriptUri, viewerJsUri, baseHref, nonce}: WebviewHtmlOptions): string {
  // CSS is injected at runtime by the Vite IIFE bundle (no separate main.css).
  // 'unsafe-inline' in style-src is required for both gravity-ui runtime style injection
  // and the Vite-inlined CSS stylesheet.
  // 'unsafe-eval' in script-src is required by viewer-static.min.js (mxGraph/draw.io viewer),
  // and also by the eval() call inside mxStencilRegistry when loading JS shape classes.
  // 'connect-src' covers the synchronous XHR that mxStencilRegistry makes to fetch stencil
  // XML and JS shape files on demand from viewer.diagrams.net.
  const csp = [
    `default-src 'none'`,
    `img-src ${cspSource} data: blob: https: http:`,
    `media-src https: http: data: blob:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource} data:`,
    `script-src 'nonce-${nonce}' 'unsafe-eval'`,
    `connect-src ${cspSource} https://viewer.diagrams.net`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <base href="${baseHref}" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Gravity Markdown Editor</title>
  <script nonce="${nonce}">window.onDrawioViewerLoad = function() {};</script>
  <script nonce="${nonce}" src="${viewerJsUri}"></script>
  <script nonce="${nonce}">mxStencilRegistry.allowEval = true;</script>
  <style>
    html, body, #root { margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden; }
    /* Reset VS Code webview injected dark styles so Gravity UI light theme takes over */
    blockquote { background: inherit; border-color: inherit; color: inherit; }
    /*
      Ctrl+F search uses @gravity-ui/uikit Popup with default z-index 1000.
      The markdown editor sticky toolbar uses z-index 2000, so the popup was hidden beneath it.
      Target the Floating UI root that wraps our search panel only.
    */
    div[data-floating-ui-placement]:has([data-qa="g-md-search-panel"]) {
      z-index: 10000 !important;
    }
    /*
      Same issue for the (?) HelpMark tooltip (e.g. the math toolbar dropdown's
      "Inline math"/"Math block" hints): its Popover also defaults to z-index 1000,
      so it renders behind the sticky toolbar instead of over it.
    */
    div[data-floating-ui-placement]:has(.g-help-mark__popover) {
      z-index: 10000 !important;
    }
    /*
      Same issue for the image popups: the edit-image form (opened from the image's "..." menu),
      that menu itself, and the toolbar's insert-image form. All are default-z-index Popups that
      can land underneath the sticky toolbar when the image sits near the top of the viewport.
    */
    div[data-floating-ui-placement]:has(.g-md-image-tooltip-form),
    div[data-floating-ui-placement]:has(.g-md-image-form),
    div[data-floating-ui-placement]:has([data-qa="g-md-image-settings-menu"]) {
      z-index: 10000 !important;
    }
    :root { --g-md-editor-padding: 8px 16px 0; }
    .ProseMirror { padding: 0 !important; }
    .ProseMirror::after { content: ''; display: block; height: 24px; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
