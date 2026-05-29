import * as path from 'path';

import * as vscode from 'vscode';

import {log} from './log';

type WebviewMessage =
  | {type: 'ready'}
  | {type: 'edit'; text: string}
  | {type: 'readDrawioFile'; src: string; id: string}
  | {type: 'openFile'; src: string};

type ExtensionMessage =
  | {type: 'update'; text: string; docDir: string}
  | {type: 'reloadImages'}
  | {type: 'config'; fontFamily: string; monospaceFontFamily: string; fontSize: number; monospaceFontSize: number; theme: 'light' | 'dark' | 'light-hc' | 'dark-hc'}
  | {type: 'drawioFileContent'; id: string; xml: string}
  | {type: 'drawioFileError'; id: string; error: string};

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
  };
}

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'gravityEdit.markdownEditor';

  constructor(private readonly extensionUri: vscode.Uri) {}

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      new MarkdownEditorProvider(context.extensionUri),
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

    let ignoreNextChange = false;

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
        log(`openFile: ${absPath}`);
        void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absPath));
        return;
      }

      if (msg.type === 'edit') {
        log(`Edit received (${msg.text.length} chars) - applying WorkspaceEdit`);
        ignoreNextChange = true;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          document.uri,
          new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length),
          ),
          msg.text,
        );
        void vscode.workspace.applyEdit(edit).then((ok) => {
          log(`WorkspaceEdit applied: ${ok}`);
          ignoreNextChange = false;
        });
      }
    });

    // Push external document changes into the webview (e.g. git checkout, other editor)
    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gravityEdit')) {
        void webviewPanel.webview.postMessage(getFontConfig() satisfies ExtensionMessage);
      }
    });

    const themeSub = vscode.window.onDidChangeActiveColorTheme(() => {
      void webviewPanel.webview.postMessage(getFontConfig() satisfies ExtensionMessage);
    });

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      if (ignoreNextChange) {
        return;
      }
      log(`External document change detected - pushing update to webview`);
      this.postUpdate(webviewPanel.webview, e.document.getText(), docDir.fsPath);
    });

    // Re-fetch images whenever the tab becomes visible (externally edited images)
    webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) {
        log('Panel became visible - requesting image reload');
        void webviewPanel.webview.postMessage({type: 'reloadImages'} satisfies ExtensionMessage);
      }
    });

    webviewPanel.onDidDispose(() => {
      log(`Webview disposed: ${document.uri.fsPath}`);
      msgSub.dispose();
      changeSub.dispose();
      configSub.dispose();
      themeSub.dispose();
    });
  }

  private postUpdate(webview: vscode.Webview, text: string, docDir: string): void {
    const msg: ExtensionMessage = {type: 'update', text, docDir};
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
    // 'unsafe-eval' in script-src is required by viewer-static.min.js (mxGraph/draw.io viewer).
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob: https: http:`,
      `media-src https: http: data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}' 'unsafe-eval'`,
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
