// Opens the real MarkdownEditorProvider against the fake vscode module and plays the
// webview's part: sending messages, answering flush requests, and recording what the
// extension posts.
import * as path from 'path';

import {MarkdownEditorProvider} from '../src/MarkdownEditorProvider';
import type {ExtensionMessage, WebviewMessage} from '../src/webview-protocol';
import {
  EventEmitter,
  FakeTextDocument,
  TextEdit,
  Uri,
  editDocument,
  fake,
  fireDocumentChange,
  resetFake,
} from './fakeVscode';

export const EXTENSION_DIR = path.resolve('/ext/gravity-edit');
export const DOC_DIR = path.resolve('/ws/docs');
export const DOC_PATH = path.join(DOC_DIR, 'note.md');

/** Let pending promise callbacks (applyEdit .then/.finally, message handlers) run. */
export async function tick(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

export interface OpenOptions {
  applyMode?: 'auto' | 'manual';
  config?: Record<string, unknown>;
  workspaceFolder?: string;
  /** Send 'ready' right away (default true), as the webview does on mount. */
  ready?: boolean;
}

export function openEditor(text: string, opts: OpenOptions = {}) {
  resetFake();
  fake.applyMode = opts.applyMode ?? 'auto';
  fake.config = opts.config ?? {};
  fake.workspaceFolder = opts.workspaceFolder ? Uri.file(opts.workspaceFolder) : undefined;

  const doc = new FakeTextDocument(DOC_PATH, text);
  fake.documents.push(doc);

  const posted: ExtensionMessage[] = [];
  const onDidReceiveMessage = new EventEmitter<WebviewMessage>();
  const onDidChangeViewState = new EventEmitter<{webviewPanel: unknown}>();
  const onDidDispose = new EventEmitter<void>();
  let flushResponder: ((id: number) => string | null) | undefined;

  const panel = {
    visible: true,
    iconPath: undefined as unknown,
    webview: {
      options: {} as {enableScripts?: boolean; localResourceRoots?: Uri[]},
      html: '',
      cspSource: 'https://webview.test',
      asWebviewUri: (uri: Uri) => Uri.parse(`https://webview.test${uri.path}`),
      postMessage: (msg: ExtensionMessage) => {
        posted.push(msg);
        if (msg.type === 'requestFlush' && flushResponder) {
          const text = flushResponder(msg.id);
          if (text !== null) {
            void Promise.resolve().then(() => onDidReceiveMessage.fire({type: 'flushResponse', id: msg.id, text}));
          }
        }
        return Promise.resolve(true);
      },
      onDidReceiveMessage: onDidReceiveMessage.event,
    },
    onDidChangeViewState: onDidChangeViewState.event,
    onDidDispose: onDidDispose.event,
  };

  const provider = new MarkdownEditorProvider(Uri.file(EXTENSION_DIR) as never, 'GeorgeSamartzidis.gravity-edit');
  provider.resolveCustomTextEditor(doc as never, panel as never, {} as never);

  const send = (msg: WebviewMessage) => onDidReceiveMessage.fire(msg);
  if (opts.ready ?? true) send({type: 'ready'});

  const editor = {
    doc,
    panel,
    posted,
    send,

    /** Messages of one type posted so far. */
    postedOf<T extends ExtensionMessage['type']>(type: T) {
      return posted.filter((m): m is Extract<ExtensionMessage, {type: T}> => m.type === type);
    },

    /** 'update' messages posted after the initial one sent on 'ready'. */
    externalUpdates() {
      return editor.postedOf('update').slice(opts.ready ?? true ? 1 : 0);
    },

    /** Simulate the webview's debounced edit post. */
    edit(text: string) {
      send({type: 'edit', text});
    },

    /** Answer every future requestFlush with fn(id); null means "never answer". */
    respondToFlush(fn: (id: number) => string | null) {
      flushResponder = fn;
    },

    /** A change made outside the webview (git checkout, another editor). */
    externalEdit(newText: string) {
      doc.setText(newText);
      fireDocumentChange(doc);
    },

    /** Change event with the text unchanged, as VS Code fires on Ctrl+S with nothing to save. */
    fireNoOpChange() {
      fireDocumentChange(doc, false);
    },

    /** Run the onWillSaveTextDocument participants; resolves with the TextEdits they contributed. */
    async willSave(): Promise<TextEdit[]> {
      const waits: Promise<TextEdit[]>[] = [];
      fake.onWillSaveTextDocument.fire({
        document: doc,
        reason: 1,
        waitUntil: (p: Promise<TextEdit[]>) => { waits.push(p); },
      });
      return (await Promise.all(waits)).flat();
    },

    /** Apply save-participant edits to the document (fires the change event, like VS Code). */
    applySaveEdits(edits: TextEdit[]) {
      for (const e of edits) editDocument(doc, e.range, e.newText);
    },

    /** The file was written: the dirty flag clears (a no-content change event), then didSave. */
    didSave() {
      doc.isDirty = false;
      fireDocumentChange(doc, false);
      fake.onDidSaveTextDocument.fire(doc);
    },

    /** Full save: participants, their edits, then didSave. */
    async save(): Promise<TextEdit[]> {
      const edits = await editor.willSave();
      editor.applySaveEdits(edits);
      editor.didSave();
      return edits;
    },

    showPanel() {
      onDidChangeViewState.fire({webviewPanel: panel});
    },

    dispose() {
      onDidDispose.fire();
    },
  };
  return editor;
}
