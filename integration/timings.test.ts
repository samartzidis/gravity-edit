// Measures, in a real VS Code, how long the document operations behind MarkdownEditorProvider's
// time limits take on large documents, and checks VS Code's own save-participant budget that
// SAVE_BUDGET_MS is sized against. The durations are printed, not asserted: they depend on the
// machine and its load. Compare them with the limits in src/MarkdownEditorProvider.ts:
//   - gate wait before a save flush (SAVE_BUDGET_MS / 2 = 500 ms) vs. applyEdit
//   - save hold until the save edit's echo (2 s fallback) vs. participant -> echo / didSave
// The webview's own share of the 1 s save budget (serializing the document for a flush) is
// measured by e2e/timings.spec.ts.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';

import {formatSize, largeMarkdown, median} from './largeDoc';

const SIZES = [100 * 1024, 1 << 20, 5 << 20];
const RUNS = 3;

const subscriptions: vscode.Disposable[] = [];
const report: string[] = [];
let docCount = 0;

async function openDoc(text: string): Promise<vscode.TextDocument> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error('integration tests need a workspace folder (see .vscode-test.mjs)');
  const file = path.join(root, `timing-${++docCount}.md`);
  fs.writeFileSync(file, text);
  return vscode.workspace.openTextDocument(file);
}

function replaceAll(doc: vscode.TextDocument, text: string): Thenable<boolean> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
  return vscode.workspace.applyEdit(edit);
}

function fullEdit(doc: vscode.TextDocument, text: string): vscode.TextEdit {
  return vscode.TextEdit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
}

/** Resolves at the first content change of `doc` whose text is `text`, with performance.now(). */
function nextEcho(doc: vscode.TextDocument, text: string): Promise<number> {
  return new Promise((resolve) => {
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === doc && e.contentChanges.length > 0 && e.document.getText() === text) {
        sub.dispose();
        resolve(performance.now());
      }
    });
    subscriptions.push(sub);
  });
}

function ms(n: number): string {
  return `${Math.round(n)} ms`.padStart(8);
}

suite('timings on large documents (printed, not asserted)', function () {
  this.timeout(180_000);

  teardown(async () => {
    for (const s of subscriptions.splice(0)) s.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  suiteTeardown(() => {
    // Shown in the test run's output, after the mocha results.
    console.log(['', 'Timings (median of ' + RUNS + ' runs):', ...report, ''].join('\n'));
  });

  // While an edit is in flight, a save waits up to 500 ms for it before flushing anyway.
  test('applyEdit of the whole document: until the echo, and until it resolves', async () => {
    report.push('applyEdit, full replace        echo   resolved   (gate wait: 500 ms)');
    for (const size of SIZES) {
      const base = largeMarkdown(size);
      const doc = await openDoc(base);
      const echo: number[] = [];
      const resolved: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const text = base + `edit ${i}\n`;
        const echoed = nextEcho(doc, text);
        const t0 = performance.now();
        assert.strictEqual(await replaceAll(doc, text), true);
        resolved.push(performance.now() - t0);
        echo.push((await echoed) - t0);
      }
      report.push(`  ${formatSize(base.length).padEnd(26)}${ms(median(echo))}${ms(median(resolved))}`);
    }
  });

  // The save flush returns the webview's text as a TextEdit, then holds the write gate until
  // VS Code applies it (the echo) or didSave, with a 2 s fallback.
  test('save with a participant edit: until the echo, didSave, and the save resolving', async () => {
    report.push('save with participant edit     echo    didSave   resolved   (save hold fallback: 2 s)');
    for (const size of SIZES) {
      const base = largeMarkdown(size);
      const doc = await openDoc(base);
      const echo: number[] = [];
      const didSave: number[] = [];
      const resolved: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        await replaceAll(doc, base + `typed ${i}\n`); // dirty, like a debounced webview edit
        const flushed = base + `flushed ${i}\n`;
        let participantDone = 0;
        let savedAt = 0;
        const echoed = nextEcho(doc, flushed);
        subscriptions.push(
          vscode.workspace.onWillSaveTextDocument((e) => {
            if (e.document !== doc) return;
            e.waitUntil(Promise.resolve([fullEdit(e.document, flushed)]).finally(() => {
              participantDone = performance.now();
            }));
          }),
          vscode.workspace.onDidSaveTextDocument((d) => {
            if (d === doc && !savedAt) savedAt = performance.now();
          }),
        );
        const t0 = performance.now();
        assert.strictEqual(await doc.save(), true);
        const end = performance.now();
        echo.push((await echoed) - participantDone);
        didSave.push(savedAt - participantDone);
        resolved.push(end - t0);
        for (const s of subscriptions.splice(0)) s.dispose();
      }
      report.push(`  ${formatSize(base.length).padEnd(26)}${ms(median(echo))}${ms(median(didSave))}  ${ms(median(resolved))}`);
    }
    report.push('  (echo and didSave are measured from the participant returning its edit)');
  });

  // SAVE_BUDGET_MS (1 s) assumes VS Code still applies a participant's edits after that long,
  // i.e. that its per-listener budget (about 1.5 s) leaves room for the gate wait + flush.
  test("VS Code's save-participant budget: an answer after 1 s (SAVE_BUDGET_MS) is applied, one after 2.5 s is dropped", async () => {
    for (const [delay, applied] of [[1000, true], [2500, false]] as const) {
      const doc = await openDoc('old\n');
      await replaceAll(doc, 'typed\n');
      const sub = vscode.workspace.onWillSaveTextDocument((e) => {
        if (e.document !== doc) return;
        e.waitUntil(new Promise<vscode.TextEdit[]>((resolve) =>
          setTimeout(() => resolve([fullEdit(e.document, 'flushed\n')]), delay)));
      });
      subscriptions.push(sub);
      await doc.save();
      sub.dispose();
      const onDisk = fs.readFileSync(doc.uri.fsPath, 'utf8');
      assert.strictEqual(onDisk, applied ? 'flushed\n' : 'typed\n',
        `participant answering after ${delay} ms should ${applied ? '' : 'not '}be applied`);
    }
    report.push("save participant budget: an edit returned after 1 s is applied, after 2.5 s it is dropped");
  });
});
