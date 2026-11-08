// Checks, against a real VS Code, the event-ordering behaviour that test/fakeVscode.ts copies
// and the sync tests (test/sync.test.ts) therefore rely on. If one of these fails, the fake is
// wrong: fix it to match, then rerun the sync tests to see whether MarkdownEditorProvider's
// write gate / save flush still hold.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';

const subscriptions: vscode.Disposable[] = [];
let docCount = 0;

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('integration tests need a workspace folder (see .vscode-test.mjs)');
  return folder.uri.fsPath;
}

async function openDoc(text: string): Promise<vscode.TextDocument> {
  const file = path.join(workspaceRoot(), `doc-${++docCount}.md`);
  fs.writeFileSync(file, text);
  return vscode.workspace.openTextDocument(file);
}

function fullRange(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
}

function replaceAll(doc: vscode.TextDocument, text: string): Thenable<boolean> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, fullRange(doc), text);
  return vscode.workspace.applyEdit(edit);
}

/** Record this document's events as readable strings, in the order they fire. */
function recordEvents(doc: vscode.TextDocument, opts: {participantText?: string} = {}): string[] {
  const events: string[] = [];
  const same = (d: vscode.TextDocument) => d.uri.toString() === doc.uri.toString();
  subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (same(e.document)) events.push(`change(${e.contentChanges.length}) ${JSON.stringify(e.document.getText())}`);
    }),
    vscode.workspace.onWillSaveTextDocument((e) => {
      if (!same(e.document)) return;
      events.push('willSave');
      if (opts.participantText !== undefined) {
        e.waitUntil(Promise.resolve([vscode.TextEdit.replace(fullRange(e.document), opts.participantText)]));
      }
    }),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (same(d)) events.push(`didSave ${JSON.stringify(d.getText())}`);
    }),
  );
  return events;
}

suite('VS Code behaviour assumed by test/fakeVscode.ts', () => {
  teardown(async () => {
    for (const s of subscriptions.splice(0)) s.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  // MarkdownEditorProvider releases its write gate when applyEdit resolves, which is only safe
  // if the edit's echo has already been delivered by then (fake: applyEdit in 'auto' mode).
  // VS Code 1.145 also fires a no-content change as the document turns dirty (fake: the
  // contentChanges-[] event in applyToDocument); it must carry the new text too.
  test('applyEdit updates the document and fires its change event before resolving', async () => {
    const doc = await openDoc('old\n');
    const events = recordEvents(doc);
    const ok = await replaceAll(doc, 'new\n');
    events.push(`resolved ${JSON.stringify(doc.getText())}`);
    assert.strictEqual(ok, true);
    assert.strictEqual(events[0], 'change(1) "new\\n"', JSON.stringify(events));
    assert.strictEqual(events.at(-1), 'resolved "new\\n"', JSON.stringify(events));
    for (const e of events.slice(1, -1)) {
      assert.strictEqual(e, 'change(0) "new\\n"', `only no-content changes with the new text may follow: ${JSON.stringify(events)}`);
    }
  });

  // The save flush contributes the webview's text as a waitUntil TextEdit and holds the gate
  // until that edit's echo or didSave (fake: harness.save() = willSave, apply edits, didSave).
  test('save applies participant edits, with a change event, before didSave and writes them to disk', async () => {
    const doc = await openDoc('old\n');
    await replaceAll(doc, 'typed\n'); // dirty, like a debounced webview edit
    const events = recordEvents(doc, {participantText: 'flushed\n'});
    assert.strictEqual(await doc.save(), true);

    const willSave = events.indexOf('willSave');
    const participantEcho = events.indexOf('change(1) "flushed\\n"');
    const didSave = events.indexOf('didSave "flushed\\n"');
    assert.ok(willSave === 0, `willSave first: ${JSON.stringify(events)}`);
    assert.ok(participantEcho > willSave, `participant edit echoed after willSave: ${JSON.stringify(events)}`);
    assert.ok(didSave > participantEcho, `didSave after the echo: ${JSON.stringify(events)}`);
    // Any other change event (VS Code 1.145 fires two no-content ones as the dirty flag clears)
    // must leave the text as saved, so the provider's lastKnownText comparison treats it as
    // "nothing new" (fake: the no-content event in harness.didSave()).
    for (const e of events.filter((ev) => ev.startsWith('change'))) {
      assert.ok(e.endsWith('"flushed\\n"'), `unexpected text in ${e}: ${JSON.stringify(events)}`);
    }
    assert.strictEqual(fs.readFileSync(doc.uri.fsPath, 'utf8'), 'flushed\n');
  });

  // Ctrl+S with nothing to save: whatever VS Code fires must not change the text
  // (the CRLF cursor-reset bug came from this event being misread as an external change).
  test('Ctrl+S on an unmodified document leaves the text unchanged in every event', async () => {
    const doc = await openDoc('same\n');
    await vscode.window.showTextDocument(doc);
    const events = recordEvents(doc);
    await vscode.commands.executeCommand('workbench.action.files.save');
    for (const e of events.filter((ev) => ev.startsWith('change') || ev.startsWith('didSave'))) {
      assert.ok(e.endsWith('"same\\n"'), `text changed in ${e}: ${JSON.stringify(events)}`);
    }
    assert.strictEqual(doc.getText(), 'same\n');
  });

  // The provider compares LF-normalized text (toLf) because getText() keeps the file's CRLF
  // while the webview only produces LF.
  test('getText() keeps CRLF line endings from disk', async () => {
    const doc = await openDoc('a\r\nb\r\n');
    assert.strictEqual(doc.eol, vscode.EndOfLine.CRLF);
    assert.strictEqual(doc.getText(), 'a\r\nb\r\n');
  });

  // The webview only produces LF. VS Code converts inserted text to the document's own line
  // ending, so a CRLF file stays CRLF (fake: editDocument normalizes to the document's EOL).
  test('LF text written into a CRLF document, by applyEdit or a save participant, stays CRLF', async () => {
    const doc = await openDoc('a\r\nb\r\n');
    await replaceAll(doc, 'x\ny\n');
    assert.strictEqual(doc.getText(), 'x\r\ny\r\n');
    recordEvents(doc, {participantText: 'p\nq\n'});
    assert.strictEqual(await doc.save(), true);
    assert.strictEqual(doc.eol, vscode.EndOfLine.CRLF);
    assert.strictEqual(fs.readFileSync(doc.uri.fsPath, 'utf8'), 'p\r\nq\r\n');
  });
});
