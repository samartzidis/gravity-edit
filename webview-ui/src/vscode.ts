import type {WebviewMessage, ExtensionMessage} from '../../src/webview-protocol';

export type {WebviewMessage, ExtensionMessage};

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewMessage): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
};

// acquireVsCodeApi() may only be called once per webview lifetime.
export const vscode = acquireVsCodeApi();
