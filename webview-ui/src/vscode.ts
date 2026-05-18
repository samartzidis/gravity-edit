/** Messages sent FROM the webview TO the extension. */
export type WebviewMessage =
  | {type: 'ready'}
  | {type: 'edit'; text: string}
  | {type: 'readDrawioFile'; src: string; id: string}
  | {type: 'openFile'; src: string};

/** Messages sent FROM the extension TO the webview. */
export type ExtensionMessage =
  | {type: 'update'; text: string; docDir: string}
  | {type: 'reloadImages'}
  | {type: 'drawioFileContent'; id: string; xml: string}
  | {type: 'drawioFileError'; id: string; error: string};

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewMessage): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
};

// acquireVsCodeApi() may only be called once per webview lifetime.
export const vscode = acquireVsCodeApi();
