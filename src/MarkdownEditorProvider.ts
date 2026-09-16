import * as path from 'path';

import * as vscode from 'vscode';

import {log} from './log';
import type {ExtensionMessage, WebviewMessage} from './webview-protocol';

const BLANK_DRAWIO_XML = `<mxfile host="app.diagrams.net">
  <diagram name="Page-1">
    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;

// The webview's markdown-editor always serializes with '\n' only (hardcoded in the
// library's MarkdownSerializerState, no config option) regardless of the document's
// actual line ending. Without normalizing document text to LF before comparing it
// against webview-originated text, a CRLF document would never textually match,
// breaking the self-echo checks this file and Editor.tsx rely on to avoid resetting
// the WYSIWYG cursor on every save. Trade-off accepted: since we always write the
// webview's LF-only text back into the document verbatim (see the 'edit' handler and
// the save-flush below), a CRLF file's line endings get silently converted to LF the
// first time it's edited through Gravity Editor.
function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({length: 32}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function resolveTheme(kind: vscode.ColorThemeKind): 'light' | 'dark' | 'light-hc' | 'dark-hc' {
  switch (kind) {
    case vscode.ColorThemeKind.Dark: return 'dark';
    case vscode.ColorThemeKind.HighContrast: return 'dark-hc';
    case vscode.ColorThemeKind.HighContrastLight: return 'light-hc';
    default: return 'light';
  }
}

function getFontConfig(): ExtensionMessage & {type: 'config'} {
  const cfg = vscode.workspace.getConfiguration('gravityEdit');
  const themeSetting = cfg.get<string>('theme', 'auto');
  const theme = themeSetting === 'auto'
    ? resolveTheme(vscode.window.activeColorTheme.kind)
    : themeSetting as 'light' | 'dark' | 'light-hc' | 'dark-hc';
  return {
    type: 'config',
    fontFamily: cfg.get<string>('fontFamily', ''),
    monospaceFontFamily: cfg.get<string>('monospaceFontFamily', ''),
    fontSize: cfg.get<number>('fontSize', 0),
    monospaceFontSize: cfg.get<number>('monospaceFontSize', 0),
    theme,
    preserveEmptyLines: cfg.get<boolean>('preserveEmptyLines', true),
    defaultMode: cfg.get<'wysiwyg' | 'markup'>('defaultMode', 'wysiwyg'),
    preserveMarkupFormatting: cfg.get<boolean>('preserveMarkupFormatting', false),
    newTableFormat: cfg.get<'gfm' | 'yfm'>('newTableFormat', 'gfm'),
    enableSlashCommands: cfg.get<boolean>('enableSlashCommands', true),
    drawioAutoFitWidth: cfg.get<boolean>('drawioAutoFitWidth', true),
  };
}

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'gravityEdit.markdownEditor';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly extensionId: string,
  ) {}

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      new MarkdownEditorProvider(context.extensionUri, context.extension.id),
      {
        webviewOptions: {retainContextWhenHidden: true},
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): void {
    const webviewDir = vscode.Uri.joinPath(this.extensionUri, 'out', 'webview');
    const drawioDir = vscode.Uri.joinPath(this.extensionUri, 'media', 'drawio');
    // Allow the document's workspace folder (for relative image paths like ./diagram.svg).
    // Falls back to the document's own directory if it isn't inside a workspace.
    const docDir = vscode.Uri.joinPath(document.uri, '..');
    const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri ?? docDir;

    log(`resolveCustomTextEditor: ${document.uri.fsPath}`);
    log(`webviewDir: ${webviewDir.fsPath}`);

    webviewPanel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'tab-icon.png');

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewDir, drawioDir, wsFolder],
    };

    webviewPanel.webview.html = this.buildHtml(webviewPanel.webview, webviewDir, drawioDir, docDir);
    log('HTML set on webview panel');

    // The document content we last wrote or observed (LF-normalized, see toLf above).
    // onDidChangeTextDocument compares against this single value to tell "new information"
    // (a genuinely external change, e.g. git checkout / another editor - push it to the
    // webview) apart from "nothing new" (our own edit's echo, or a true no-op like VS
    // Code's benign Ctrl+S-with-nothing-changed event) - one canonical comparison instead
    // of a pendingEdits counter plus a separate contentChanges.length check. Every write
    // site below updates this synchronously, right when it decides what to write, before
    // the write's async result is known.
    // Accepted trade-off: two forced flushes firing back-to-back (e.g. blur and tab-hidden
    // in quick succession) can each post an 'edit'; if their onDidChangeTextDocument echoes
    // fire in submission order, the first echo may transiently mismatch (lastKnownText has
    // already advanced to the second edit's target), causing one spurious postUpdate before
    // the second echo re-converges. This only happens when forced flushes overlap - never
    // from typing alone (single-flight due to the debounce) - i.e. specifically when the
    // user has already left the WYSIWYG surface, so the transient isn't visible, and it
    // self-corrects within the same event-loop turn.
    let lastKnownText = toLf(document.getText());

    // Save-time flush: the webview debounces 'edit' posts (serializing the whole document
    // on every keystroke blocked its UI thread on large files), so at save time the
    // TextDocument may lag the editor by up to the debounce interval. onWillSaveTextDocument
    // asks the webview for its current content and contributes the difference as a save edit.
    let flushSeq = 0;
    const pendingFlushes = new Map<number, (text: string | null) => void>();

    // Receive messages from webview
    const msgSub = webviewPanel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      log(`Received message from webview: type=${msg.type}`);

      if (msg.type === 'ready') {
        const text = document.getText();
        log(`Webview ready - sending update (${text.length} chars)`);
        this.postUpdate(webviewPanel.webview, text, docDir.fsPath);
        void webviewPanel.webview.postMessage(getFontConfig() satisfies ExtensionMessage);
        return;
      }

      if (msg.type === 'flushResponse') {
        pendingFlushes.get(msg.id)?.(msg.text);
        return;
      }

      if (msg.type === 'readDrawioFile') {
        const absPath = path.isAbsolute(msg.src)
          ? msg.src
          : path.resolve(docDir.fsPath, msg.src);
        log(`readDrawioFile: ${absPath}`);
        void vscode.workspace.fs.readFile(vscode.Uri.file(absPath)).then(
          (bytes) => {
            const xml = Buffer.from(bytes).toString('utf8');
            void webviewPanel.webview.postMessage(
              {type: 'drawioFileContent', id: msg.id, xml} satisfies ExtensionMessage,
            );
          },
          (err: unknown) => {
            const error = err instanceof Error ? err.message : String(err);
            log(`readDrawioFile error: ${error}`);
            void webviewPanel.webview.postMessage(
              {type: 'drawioFileError', id: msg.id, error} satisfies ExtensionMessage,
            );
          },
        );
        return;
      }

      if (msg.type === 'openFile') {
        const absPath = path.isAbsolute(msg.src)
          ? msg.src
          : path.resolve(docDir.fsPath, msg.src);
        const uri = vscode.Uri.file(absPath);
        const openMdLinksIn = vscode.workspace.getConfiguration('gravityEdit')
          .get<'gravityEdit' | 'systemDefault'>('openMdLinksIn', 'gravityEdit');
        if (absPath.toLowerCase().endsWith('.md') && openMdLinksIn === 'gravityEdit') {
          // Force Gravity Editor for markdown targets reached from inside this webview
          // (link follow), independent of the extension's customEditors `priority` -
          // which stays "option" so unrelated .md opens (Explorer, other extensions)
          // are unaffected. gravityEdit.openMdLinksIn opts out per-user.
          log(`openFile: ${absPath} (opening with ${MarkdownEditorProvider.viewType})`);
          void vscode.commands.executeCommand('vscode.openWith', uri, MarkdownEditorProvider.viewType);
        } else {
          log(`openFile: ${absPath}`);
          void vscode.commands.executeCommand('vscode.open', uri);
        }
        return;
      }

      if (msg.type === 'insertDrawio') {
        log('insertDrawio: showing save dialog');
        void vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.joinPath(docDir, 'diagram.drawio'),
          filters: {'Draw.io Diagram': ['drawio']},
        }).then(async (uri) => {
          if (!uri) {
            log('insertDrawio: cancelled');
            return;
          }
          await vscode.workspace.fs.writeFile(uri, Buffer.from(BLANK_DRAWIO_XML, 'utf8'));
          const src = path.relative(docDir.fsPath, uri.fsPath).replace(/\\/g, '/');
          log(`insertDrawio: created ${uri.fsPath}, src=${src}`);
          void webviewPanel.webview.postMessage({type: 'drawioFileCreated', src} satisfies ExtensionMessage);
        }, (err: unknown) => {
          const error = err instanceof Error ? err.message : String(err);
          log(`insertDrawio error: ${error}`);
        });
        return;
      }

      if (msg.type === 'openSettings') {
        log('openSettings: opening extension settings');
        void vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${this.extensionId}`);
        return;
      }

      if (msg.type === 'openExternal') {
        // target="_blank" links (e.g. the library's built-in "Documentation" link) are
        // silently swallowed by the webview iframe's sandbox (no allow-popups), so they
        // must be forwarded here instead. Restrict to http(s) - this is reachable from
        // arbitrary library/DOM content, not just our own trusted markup.
        if (!/^https?:\/\//i.test(msg.url)) {
          log(`openExternal: rejected non-http(s) URL: ${msg.url}`);
          return;
        }
        log(`openExternal: ${msg.url}`);
        void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      }

      if (msg.type === 'edit') {
        log(`Edit received (${msg.text.length} chars) - applying WorkspaceEdit`);
        // Set before applyEdit so the resulting onDidChangeTextDocument (which can fire
        // before .then() runs) already matches lastKnownText and is recognized as "nothing
        // new" rather than misread as an external change.
        lastKnownText = msg.text;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          document.uri,
          new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length),
          ),
          msg.text,
        );
        void Promise.resolve(vscode.workspace.applyEdit(edit)).then((ok) => {
          log(`WorkspaceEdit applied: ${ok}`);
          if (!ok) {
            // The write never happened - resync so a later external change isn't
            // silently swallowed by comparing against this now-stale optimistic value.
            lastKnownText = toLf(document.getText());
          }
        });
      }
    });

    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gravityEdit')) {
        void webviewPanel.webview.postMessage(getFontConfig() satisfies ExtensionMessage);
      }
    });

    const themeSub = vscode.window.onDidChangeActiveColorTheme(() => {
      void webviewPanel.webview.postMessage(getFontConfig() satisfies ExtensionMessage);
    });

    // Forward external document changes to the webview (e.g. git checkout, another editor).
    // Changes originating from the webview itself are excluded via lastKnownText (see above).
    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      const currentText = toLf(e.document.getText());
      // Nothing new: either the echo of our own edit/flush, or a true no-op (e.g. VS
      // Code's benign Ctrl+S-with-nothing-changed event, which leaves the text unchanged).
      if (currentText === lastKnownText) {
        return;
      }
      lastKnownText = currentText;
      log(`External document change detected - pushing update to webview`);
      this.postUpdate(webviewPanel.webview, e.document.getText(), docDir.fsPath);
    });

    // Participate in save so a debounce-pending webview edit is included in the saved file.
    // waitUntil TextEdits are the sanctioned channel here — applyEdit made during this
    // event is not guaranteed to be included in the save.
    const willSaveSub = vscode.workspace.onWillSaveTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      const id = ++flushSeq;
      log(`onWillSaveTextDocument - requesting webview flush (id=${id})`);
      e.waitUntil(new Promise<vscode.TextEdit[]>((resolve) => {
        const finish = (text: string | null) => {
          if (!pendingFlushes.delete(id)) return; // already finished (response + timeout race)
          if (text === null || text === lastKnownText) {
            resolve([]);
            return;
          }
          log(`Save flush (id=${id}) applying webview content (${text.length} chars)`);
          lastKnownText = text;
          // The onDidChangeTextDocument echo of this edit is suppressed webview-side:
          // an 'update' whose text matches the editor's current value is skipped there.
          resolve([vscode.TextEdit.replace(
            new vscode.Range(
              e.document.positionAt(0),
              e.document.positionAt(e.document.getText().length),
            ),
            text,
          )]);
        };
        pendingFlushes.set(id, finish);
        // Don't stall the save if the webview never answers (e.g. it was just disposed).
        setTimeout(() => finish(null), 1000);
        void webviewPanel.webview.postMessage({type: 'requestFlush', id} satisfies ExtensionMessage);
      }));
    });

    // Re-fetch images whenever the tab becomes visible (externally edited images)
    webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) {
        log('Panel became visible - requesting image reload');
        void webviewPanel.webview.postMessage({type: 'reloadImages'} satisfies ExtensionMessage);
      }
    });

    const windowFocusSub = vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && webviewPanel.visible)
        void webviewPanel.webview.postMessage({type: 'reloadImages'} satisfies ExtensionMessage);
    });

    webviewPanel.onDidDispose(() => {
      log(`Webview disposed: ${document.uri.fsPath}`);
      msgSub.dispose();
      changeSub.dispose();
      configSub.dispose();
      themeSub.dispose();
      windowFocusSub.dispose();
      willSaveSub.dispose();
      // Unblock any in-flight save waiting on a webview that will never answer.
      for (const finish of [...pendingFlushes.values()]) finish(null);
    });
  }

  private postUpdate(webview: vscode.Webview, text: string, docDir: string): void {
    // Normalize to '\n' - the webview's markdown-editor always serializes with LF only
    // (see toLf above), so this keeps every 'update' consistent with what the webview
    // itself would produce, regardless of the document's actual line ending.
    const msg: ExtensionMessage = {type: 'update', text: toLf(text), docDir};
    void webview.postMessage(msg).then(
      (delivered) => log(`postMessage(update) delivered=${delivered}`),
    );
  }

  private buildHtml(
    webview: vscode.Webview,
    webviewDir: vscode.Uri,
    drawioDir: vscode.Uri,
    docDir: vscode.Uri,
  ): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, 'main.js'),
    );
    const viewerJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(drawioDir, 'viewer-static.min.js'),
    );
    // Base href makes all relative image paths in the markdown resolve correctly
    // without any text manipulation - the browser handles it transparently.
    const baseHref = webview.asWebviewUri(docDir).toString() + '/';
    const nonce = getNonce();

    // CSS is injected at runtime by the Vite IIFE bundle (no separate main.css).
    // 'unsafe-inline' in style-src is required for both gravity-ui runtime style injection
    // and the Vite-inlined CSS stylesheet.
    // 'unsafe-eval' in script-src is required by viewer-static.min.js (mxGraph/draw.io viewer),
    // and also by the eval() call inside mxStencilRegistry when loading JS shape classes.
    // 'connect-src' covers the synchronous XHR that mxStencilRegistry makes to fetch stencil
    // XML and JS shape files on demand from viewer.diagrams.net.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob: https: http:`,
      `media-src https: http: data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}' 'unsafe-eval'`,
      `connect-src ${webview.cspSource} https://viewer.diagrams.net`,
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
}
