import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | undefined;

export function getLog(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel('Gravity Edit');
  }
  return _channel;
}

export function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  getLog().appendLine(`[${ts}] ${msg}`);
}
