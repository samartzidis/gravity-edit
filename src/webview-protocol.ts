// Shared protocol types — NO vscode imports; this file is compiled into both the extension host and the webview bundle.

/** Messages sent FROM the webview TO the extension. */
export type WebviewMessage =
  | {type: 'ready'}
  | {type: 'edit'; text: string}
  | {type: 'readDrawioFile'; src: string; id: string}
  | {type: 'openFile'; src: string}
  | {type: 'openSettings'};

/** Messages sent FROM the extension TO the webview. */
export type ExtensionMessage =
  | {type: 'update'; text: string; docDir: string}
  | {type: 'reloadImages'}
  | {type: 'config'; fontFamily: string; monospaceFontFamily: string; fontSize: number; monospaceFontSize: number; theme: 'light' | 'dark' | 'light-hc' | 'dark-hc'}
  | {type: 'drawioFileContent'; id: string; xml: string}
  | {type: 'drawioFileError'; id: string; error: string};
