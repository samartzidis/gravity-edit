import * as vscode from 'vscode';

import {MarkdownEditorProvider} from './MarkdownEditorProvider';
import {getLog, log} from './log';

const GRAVITY_EDITOR_VIEW_TYPE = 'gravityEdit.markdownEditor';

function isMarkdownUri(uri: vscode.Uri): boolean {
  return uri.path.toLowerCase().endsWith('.md');
}

async function openWithGravity(...args: unknown[]): Promise<void> {
  const first = args[0];
  const second = args[1];
  let uris: vscode.Uri[] = [];

  if (first instanceof vscode.Uri) {
    uris = Array.isArray(second) && second.every((u) => u instanceof vscode.Uri) ? second : [first];
  } else if (vscode.window.activeTextEditor?.document.languageId === 'markdown') {
    uris = [vscode.window.activeTextEditor.document.uri];
  }

  uris = uris.filter(isMarkdownUri);

  if (uris.length === 0) {
    void vscode.window.showWarningMessage(
      'Select a Markdown file in the Explorer or focus a Markdown editor.'
    );
    return;
  }

  for (const uri of uris) {
    await vscode.commands.executeCommand('vscode.openWith', uri, GRAVITY_EDITOR_VIEW_TYPE);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(MarkdownEditorProvider.register(context));
  context.subscriptions.push(
    vscode.commands.registerCommand('gravityEdit.openWithGravity', openWithGravity)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('gravityEdit.noOp', () => { /* intentional no-op: absorbs keybindings that would otherwise leak to VS Code workbench */ })
  );
  context.subscriptions.push(getLog());
  log('Gravity Edit activated - Output channel ready');
}

export function deactivate(): void {}
