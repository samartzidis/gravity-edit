// Document sync between the webview and the TextDocument (MarkdownEditorProvider's write
// gate, queued edit, save flush/hold and lastKnownText). Several cases replay real bugs:
// cursor jumps caused by our own edits' echoes being mistaken for external changes.
import {afterEach, describe, expect, it, vi} from 'vitest';

import {fake} from './fakeVscode';
import {openEditor, tick} from './harness';

afterEach(() => {
  vi.useRealTimers();
});

describe('own edits vs external changes', () => {
  it('applies a webview edit without echoing it back as an update', async () => {
    const ed = openEditor('a\n');
    ed.edit('a\nb\n');
    await tick();
    expect(fake.applyEditCalls).toEqual(['a\nb\n']);
    expect(ed.doc.getText()).toBe('a\nb\n');
    expect(ed.externalUpdates()).toEqual([]);
  });

  it('pushes an external change to the webview, LF-normalized', async () => {
    const ed = openEditor('a\n');
    ed.externalEdit('x\r\ny\r\n');
    expect(ed.externalUpdates()).toEqual([{type: 'update', text: 'x\ny\n', docDir: expect.any(String)}]);
  });

  it('ignores a change event that leaves the text unchanged (Ctrl+S with nothing to save)', () => {
    const ed = openEditor('a\n');
    ed.fireNoOpChange();
    expect(ed.externalUpdates()).toEqual([]);
  });

  it('ignores change events and saves of other documents', async () => {
    const ed = openEditor('a\n');
    const other = {uri: {toString: () => 'file:///elsewhere.md'}, getText: () => 'zzz'};
    fake.onDidChangeTextDocument.fire({document: other as never, contentChanges: []});
    fake.onWillSaveTextDocument.fire({document: other, waitUntil: () => { throw new Error('should not participate'); }});
    expect(ed.externalUpdates()).toEqual([]);
    expect(ed.postedOf('requestFlush')).toEqual([]);
  });
});

describe('CRLF documents', () => {
  it('sends LF text on ready', () => {
    const ed = openEditor('a\r\nb\r\n');
    expect(ed.postedOf('update')[0].text).toBe('a\nb\n');
  });

  it('saving unchanged content adds no edit (regression: Ctrl+S reset the cursor on CRLF files)', async () => {
    const ed = openEditor('a\r\nb\r\n');
    ed.respondToFlush(() => 'a\nb\n'); // the webview always serializes LF
    expect(await ed.save()).toEqual([]);
    expect(ed.externalUpdates()).toEqual([]);
  });

  it('ignores a no-op change event (Ctrl+S with nothing to save)', () => {
    const ed = openEditor('a\r\nb\r\n');
    ed.fireNoOpChange();
    expect(ed.externalUpdates()).toEqual([]);
  });

  it('does not echo its own edit back (VS Code keeps the document CRLF, see integration/)', async () => {
    const ed = openEditor('a\r\nb\r\n');
    ed.edit('a\nb\nc\n');
    await tick();
    expect(ed.doc.getText()).toBe('a\r\nb\r\nc\r\n');
    expect(ed.externalUpdates()).toEqual([]);
  });

  it('a save flush into a CRLF document keeps it CRLF without echoing an update', async () => {
    const ed = openEditor('a\r\n');
    ed.respondToFlush(() => 'a\nb\n');
    await ed.save();
    expect(ed.doc.getText()).toBe('a\r\nb\r\n');
    expect(ed.externalUpdates()).toEqual([]);
  });
});

describe('failed edits', () => {
  it('resyncs after applyEdit resolves false, so a later external change is not swallowed', async () => {
    const ed = openEditor('orig', {applyMode: 'manual'});
    ed.edit('new');
    fake.pendingEdits.shift()!.settle(false);
    await tick();
    expect(ed.doc.getText()).toBe('orig');
    // An external change that happens to match the failed edit's text must still reach the webview.
    ed.externalEdit('new');
    expect(ed.externalUpdates().map((m) => m.text)).toEqual(['new']);
  });

  it('resyncs after applyEdit rejects', async () => {
    const ed = openEditor('orig', {applyMode: 'manual'});
    ed.edit('new');
    fake.pendingEdits.shift()!.reject(new Error('boom'));
    await tick();
    ed.externalEdit('new');
    expect(ed.externalUpdates().map((m) => m.text)).toEqual(['new']);
  });

  it('releases the gate after a failed edit', async () => {
    const ed = openEditor('orig', {applyMode: 'manual'});
    ed.edit('v1');
    fake.pendingEdits.shift()!.settle(false);
    await tick();
    ed.edit('v2');
    expect(fake.applyEditCalls).toEqual(['v1', 'v2']);
  });
});

describe('write gate', () => {
  it('runs one edit at a time and keeps only the latest queued one', async () => {
    const ed = openEditor('v0', {applyMode: 'manual'});
    ed.edit('v1');
    ed.edit('v2');
    ed.edit('v3');
    expect(fake.applyEditCalls).toEqual(['v1']);

    fake.pendingEdits.shift()!.settle();
    await tick();
    expect(fake.applyEditCalls).toEqual(['v1', 'v3']);

    fake.pendingEdits.shift()!.settle();
    await tick();
    expect(ed.doc.getText()).toBe('v3');
    expect(ed.externalUpdates()).toEqual([]);
  });

  it('fast typing then Ctrl+S: no update reaches the webview (regression: cursor vanished)', async () => {
    const ed = openEditor('v0', {applyMode: 'manual'});
    ed.respondToFlush(() => 'v2');
    ed.edit('v1');
    const saving = ed.willSave(); // waits for the in-flight edit
    await tick();
    expect(ed.postedOf('requestFlush')).toEqual([]);

    fake.pendingEdits.shift()!.settle();
    await tick();
    const edits = await saving;
    expect(edits.map((e) => e.newText)).toEqual(['v2']);

    ed.applySaveEdits(edits);
    ed.didSave();
    expect(ed.doc.getText()).toBe('v2');
    expect(ed.externalUpdates()).toEqual([]);
  });

  it('a save waiting on the gate supersedes an edit queued behind it', async () => {
    const ed = openEditor('v0', {applyMode: 'manual'});
    ed.respondToFlush(() => 'v3');
    ed.edit('v1');
    ed.edit('v2'); // queued
    const saving = ed.willSave(); // waiting for the gate

    fake.pendingEdits.shift()!.settle();
    await tick();
    const edits = await saving;
    ed.applySaveEdits(edits);
    ed.didSave();
    await tick();

    expect(fake.applyEditCalls).toEqual(['v1']); // v2 was dropped, never applied
    expect(ed.doc.getText()).toBe('v3');
    expect(ed.externalUpdates()).toEqual([]);
  });
});

describe('save flush', () => {
  it('contributes no edit when the webview content matches the document, and frees the gate', async () => {
    const ed = openEditor('same', {applyMode: 'manual'});
    ed.respondToFlush(() => 'same');
    expect(await ed.save()).toEqual([]);
    ed.edit('next');
    expect(fake.applyEditCalls).toEqual(['next']);
  });

  it('contributes one full-document edit when the webview is ahead (debounce pending)', async () => {
    const ed = openEditor('old');
    ed.respondToFlush(() => 'newer');
    const edits = await ed.save();
    expect(edits).toHaveLength(1);
    expect(edits[0].newText).toBe('newer');
    expect(edits[0].range).toEqual({start: 0, end: 3});
    expect(ed.doc.getText()).toBe('newer');
    expect(ed.externalUpdates()).toEqual([]);
  });

  it('holds the gate until the save edit is echoed, so a following edit cannot overlap it', async () => {
    const ed = openEditor('old', {applyMode: 'manual'});
    ed.respondToFlush(() => 'flushed');
    const edits = await ed.willSave();

    ed.edit('typed-after'); // arrives before VS Code applied the save edit
    expect(fake.applyEditCalls).toEqual([]);

    ed.applySaveEdits(edits); // echo releases the hold
    await tick();
    expect(fake.applyEditCalls).toEqual(['typed-after']);
    expect(ed.externalUpdates()).toEqual([]);
  });

  it('typing during a save: the dirty-flag events after the save edit are not taken for external changes (regression)', async () => {
    const ed = openEditor('v0', {applyMode: 'manual'});
    ed.respondToFlush(() => 'flushed');
    const edits = await ed.willSave();
    ed.edit('typed-during-save'); // queued behind the save hold
    ed.applySaveEdits(edits); // echo: hold released, the queued edit starts at once
    ed.didSave(); // dirty flag clears: a no-content event that still carries 'flushed'
    fake.pendingEdits.shift()!.settle();
    await tick();
    expect(fake.applyEditCalls).toEqual(['typed-during-save']);
    expect(ed.doc.getText()).toBe('typed-during-save');
    expect(ed.externalUpdates()).toEqual([]);
  });

  it('releases the save hold on didSave if no echo arrives', async () => {
    const ed = openEditor('old', {applyMode: 'manual'});
    ed.respondToFlush(() => 'flushed');
    await ed.willSave();
    ed.edit('later');
    expect(fake.applyEditCalls).toEqual([]);
    ed.didSave();
    expect(fake.applyEditCalls).toEqual(['later']);
  });

  it('releases the save hold after 2s if neither echo nor didSave arrives', async () => {
    vi.useFakeTimers();
    const ed = openEditor('old', {applyMode: 'manual'});
    ed.respondToFlush(() => 'flushed');
    await ed.willSave();
    ed.edit('later');
    await vi.advanceTimersByTimeAsync(1999);
    expect(fake.applyEditCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.applyEditCalls).toEqual(['later']);
  });

  it('does not stall the save when the webview never answers (1s budget)', async () => {
    vi.useFakeTimers();
    const ed = openEditor('doc');
    ed.respondToFlush(() => null);
    let result: unknown;
    void ed.willSave().then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual([]);
  });

  it('flushes without the gate if an in-flight edit never settles', async () => {
    vi.useFakeTimers();
    const ed = openEditor('v0', {applyMode: 'manual'});
    ed.respondToFlush(() => 'v2');
    ed.edit('v1'); // never settles
    let result: {newText: string}[] | undefined;
    void ed.willSave().then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(500); // gate wait = half the budget
    expect(result?.map((e) => e.newText)).toEqual(['v2']);
    expect(fake.logs.some((l) => l.includes('gate wait timed out'))).toBe(true);
  });

  it('unblocks a pending save as soon as the panel is disposed', async () => {
    vi.useFakeTimers(); // so the 1s flush timeout can't be what resolves it
    const ed = openEditor('doc');
    ed.respondToFlush(() => null);
    let result: unknown;
    void ed.willSave().then((r) => { result = r; });
    await tick();
    expect(result).toBeUndefined();
    ed.dispose();
    await tick();
    expect(result).toEqual([]);
  });

  it('stops reacting to document events after dispose', async () => {
    const ed = openEditor('doc');
    ed.dispose();
    ed.externalEdit('changed');
    expect(ed.externalUpdates()).toEqual([]);
  });
});
