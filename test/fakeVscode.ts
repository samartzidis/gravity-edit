// A small fake of the parts of the 'vscode' API that src/ uses, aliased in vitest.config.ts.
// Only what MarkdownEditorProvider, log.ts and extension.ts touch is implemented. Tests drive
// it through `fake` (state + controls) and the helpers in harness.ts; call resetFake() before
// each test.
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Listener<T> = (e: T) => unknown;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];

  readonly event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return {dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); }};
  };

  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly fsPath: string,
    private readonly raw?: string,
  ) {}

  static file(p: string): Uri {
    return new Uri('file', path.normalize(p));
  }

  static parse(s: string): Uri {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1] ?? '';
    return new Uri(scheme, '', s);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return Uri.file(path.join(base.fsPath, ...segments));
  }

  get path(): string {
    const p = this.fsPath.replace(/\\/g, '/');
    return p.startsWith('/') ? p : '/' + p;
  }

  toString(): string {
    return this.raw ?? `file://${this.path}`;
  }
}

export class Range {
  constructor(readonly start: number, readonly end: number) {}
}

export class TextEdit {
  constructor(readonly range: Range, readonly newText: string) {}

  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }
}

export class WorkspaceEdit {
  readonly entries: {uri: Uri; range: Range; newText: string}[] = [];

  replace(uri: Uri, range: Range, newText: string): void {
    this.entries.push({uri, range, newText});
  }
}

export enum ColorThemeKind {
  Light = 1,
  Dark = 2,
  HighContrast = 3,
  HighContrastLight = 4,
}

/** Minimal TextDocument: positions are plain string offsets. */
export class FakeTextDocument {
  readonly uri: Uri;
  isDirty = false;

  constructor(fsPath: string, private text: string) {
    this.uri = Uri.file(fsPath);
  }

  getText(): string {
    return this.text;
  }

  positionAt(offset: number): number {
    return offset;
  }

  setText(text: string): void {
    this.text = text;
  }
}

export interface PendingEdit {
  text: string;
  /** Apply the edit (unless ok=false), fire onDidChangeTextDocument, then resolve applyEdit. */
  settle(ok?: boolean): void;
  /** Make applyEdit reject without changing the document. */
  reject(err: Error): void;
}

function createState() {
  return {
    /** 'auto': applyEdit applies on the next microtask and resolves true. 'manual': it waits for a test to settle it. */
    applyMode: 'auto' as 'auto' | 'manual',
    /** Text of every applyEdit call, in order. */
    applyEditCalls: [] as string[],
    pendingEdits: [] as PendingEdit[],
    documents: [] as FakeTextDocument[],
    config: {} as Record<string, unknown>,
    workspaceFolder: undefined as Uri | undefined,
    themeKind: ColorThemeKind.Light,
    executedCommands: [] as {command: string; args: unknown[]}[],
    openedExternal: [] as string[],
    files: new Map<string, string>(),
    writtenFiles: new Map<string, string>(),
    saveDialogResult: undefined as Uri | undefined,
    logs: [] as string[],
    onDidChangeTextDocument: new EventEmitter<{document: FakeTextDocument; contentChanges: unknown[]}>(),
    onWillSaveTextDocument: new EventEmitter<any>(),
    onDidSaveTextDocument: new EventEmitter<FakeTextDocument>(),
    onDidChangeConfiguration: new EventEmitter<{affectsConfiguration(section: string): boolean}>(),
    onDidChangeActiveColorTheme: new EventEmitter<unknown>(),
    onDidChangeWindowState: new EventEmitter<{focused: boolean}>(),
  };
}

export let fake = createState();

export function resetFake(): void {
  fake = createState();
}

/**
 * Fire onDidChangeTextDocument for `doc`. With `contentChanged` false it is the no-content
 * event VS Code fires when only the dirty flag changes (contentChanges: []).
 * The event sequences below match what integration/eventOrder.test.ts observes in real VS Code.
 */
export function fireDocumentChange(doc: FakeTextDocument, contentChanged = true): void {
  fake.onDidChangeTextDocument.fire({document: doc, contentChanges: contentChanged ? [{}] : []});
}

/**
 * Replace a range of the document's text, as VS Code applies an edit: inserted line endings are
 * converted to the document's own (a CRLF document stays CRLF); a content change event fires,
 * then the dirty-flag event if it just became dirty.
 */
export function editDocument(doc: FakeTextDocument, range: Range, newText: string): void {
  const old = doc.getText();
  const wasDirty = doc.isDirty;
  const eol = old.includes('\r\n') ? '\r\n' : '\n';
  doc.setText(old.slice(0, range.start) + newText.replace(/\r?\n/g, eol) + old.slice(range.end));
  doc.isDirty = true;
  fireDocumentChange(doc);
  if (!wasDirty) fireDocumentChange(doc, false);
}

function applyToDocument(edit: WorkspaceEdit): void {
  for (const entry of edit.entries) {
    const doc = fake.documents.find((d) => d.uri.toString() === entry.uri.toString());
    if (doc) editDocument(doc, entry.range, entry.newText);
  }
}

export const workspace = {
  getWorkspaceFolder: (_uri: Uri) => (fake.workspaceFolder ? {uri: fake.workspaceFolder} : undefined),

  getConfiguration: (_section: string) => ({
    get: <T>(key: string, defaultValue: T): T => (key in fake.config ? fake.config[key] as T : defaultValue),
  }),

  applyEdit(edit: WorkspaceEdit): Promise<boolean> {
    fake.applyEditCalls.push(edit.entries.map((e) => e.newText).join(''));
    if (fake.applyMode === 'auto') {
      // Like VS Code: the extension-host document (and its change event) updates before the
      // promise resolves.
      return Promise.resolve().then(() => {
        applyToDocument(edit);
        return true;
      });
    }
    return new Promise<boolean>((resolve, reject) => {
      fake.pendingEdits.push({
        text: edit.entries.map((e) => e.newText).join(''),
        settle: (ok = true) => {
          if (ok) applyToDocument(edit);
          resolve(ok);
        },
        reject,
      });
    });
  },

  fs: {
    readFile: async (uri: Uri): Promise<Uint8Array> => {
      const content = fake.files.get(uri.fsPath);
      if (content === undefined) throw new Error(`ENOENT: ${uri.fsPath}`);
      return new TextEncoder().encode(content);
    },
    writeFile: async (uri: Uri, bytes: Uint8Array): Promise<void> => {
      fake.writtenFiles.set(uri.fsPath, new TextDecoder().decode(bytes));
    },
  },

  onDidChangeTextDocument: (l: Listener<any>) => fake.onDidChangeTextDocument.event(l),
  onWillSaveTextDocument: (l: Listener<any>) => fake.onWillSaveTextDocument.event(l),
  onDidSaveTextDocument: (l: Listener<any>) => fake.onDidSaveTextDocument.event(l),
  onDidChangeConfiguration: (l: Listener<any>) => fake.onDidChangeConfiguration.event(l),
};

export const window = {
  get activeColorTheme() {
    return {kind: fake.themeKind};
  },
  activeTextEditor: undefined,
  createOutputChannel: (_name: string) => ({
    appendLine: (line: string) => { fake.logs.push(line); },
    dispose: () => {},
  }),
  showSaveDialog: async (_opts: unknown) => fake.saveDialogResult,
  showWarningMessage: async (_msg: string) => undefined,
  registerCustomEditorProvider: () => ({dispose: () => {}}),
  onDidChangeActiveColorTheme: (l: Listener<any>) => fake.onDidChangeActiveColorTheme.event(l),
  onDidChangeWindowState: (l: Listener<any>) => fake.onDidChangeWindowState.event(l),
};

export const commands = {
  executeCommand: async (command: string, ...args: unknown[]) => {
    fake.executedCommands.push({command, args});
    return undefined;
  },
  registerCommand: () => ({dispose: () => {}}),
};

export const env = {
  openExternal: async (uri: Uri) => {
    fake.openedExternal.push(uri.toString());
    return true;
  },
};
