// Webview -> extension messages other than document sync, plus config/theme/visibility pushes.
import * as path from 'path';

import {describe, expect, it} from 'vitest';

import {ColorThemeKind, Uri, fake} from './fakeVscode';
import {DOC_DIR, openEditor, tick} from './harness';

const DEFAULT_CONFIG = {
  type: 'config',
  fontFamily: '',
  monospaceFontFamily: '',
  fontSize: 0,
  monospaceFontSize: 0,
  theme: 'light',
  preserveEmptyLines: true,
  defaultMode: 'wysiwyg',
  preserveMarkupFormatting: false,
  newTableFormat: 'gfm',
  enableSlashCommands: true,
  drawioAutoFitWidth: true,
};

describe('ready', () => {
  it('posts the document, then the config (the webview mounts once it has both)', () => {
    const ed = openEditor('# Hi\r\n');
    expect(ed.posted.map((m) => m.type)).toEqual(['update', 'config']);
    expect(ed.posted[0]).toEqual({type: 'update', text: '# Hi\n', docDir: DOC_DIR});
    expect(ed.posted[1]).toEqual(DEFAULT_CONFIG);
  });

  it('passes gravityEdit.* settings through', () => {
    const ed = openEditor('', {config: {fontSize: 15, newTableFormat: 'yfm', enableSlashCommands: false, theme: 'dark-hc'}});
    expect(ed.postedOf('config')[0]).toMatchObject({fontSize: 15, newTableFormat: 'yfm', enableSlashCommands: false, theme: 'dark-hc'});
  });

  it.each([
    [ColorThemeKind.Light, 'light'],
    [ColorThemeKind.Dark, 'dark'],
    [ColorThemeKind.HighContrast, 'dark-hc'],
    [ColorThemeKind.HighContrastLight, 'light-hc'],
  ])('theme "auto" follows the VS Code theme kind %i -> %s', (kind, theme) => {
    const ed = openEditor('', {ready: false});
    fake.themeKind = kind;
    ed.send({type: 'ready'});
    expect(ed.postedOf('config')[0].theme).toBe(theme);
  });
});

describe('config and theme changes', () => {
  it('re-posts config when a gravityEdit setting changes', () => {
    const ed = openEditor('');
    fake.config = {fontSize: 20};
    fake.onDidChangeConfiguration.fire({affectsConfiguration: (s) => s === 'gravityEdit'});
    expect(ed.postedOf('config').map((c) => c.fontSize)).toEqual([0, 20]);
  });

  it('ignores unrelated setting changes', () => {
    const ed = openEditor('');
    fake.onDidChangeConfiguration.fire({affectsConfiguration: () => false});
    expect(ed.postedOf('config')).toHaveLength(1);
  });

  it('re-posts config when the color theme changes', () => {
    const ed = openEditor('');
    fake.themeKind = ColorThemeKind.Dark;
    fake.onDidChangeActiveColorTheme.fire({});
    expect(ed.postedOf('config').map((c) => c.theme)).toEqual(['light', 'dark']);
  });
});

describe('openExternal', () => {
  it.each(['https://example.com/x?y=1', 'http://example.com'])('opens %s', (url) => {
    const ed = openEditor('');
    ed.send({type: 'openExternal', url});
    expect(fake.openedExternal).toEqual([url]);
  });

  it.each(['file:///C:/Windows/system32/calc.exe', 'javascript:alert(1)', 'command:workbench.action.reloadWindow', 'vscode://x'])(
    'rejects %s', (url) => {
      const ed = openEditor('');
      ed.send({type: 'openExternal', url});
      expect(fake.openedExternal).toEqual([]);
    });
});

describe('openFile', () => {
  const lastCommand = () => {
    const c = fake.executedCommands.at(-1)!;
    return {command: c.command, fsPath: (c.args[0] as Uri).fsPath, rest: c.args.slice(1)};
  };

  it('opens a relative .md link in Gravity Editor, resolved against the document folder', () => {
    const ed = openEditor('');
    ed.send({type: 'openFile', src: 'other.md'});
    expect(lastCommand()).toEqual({command: 'vscode.openWith', fsPath: path.join(DOC_DIR, 'other.md'), rest: ['gravityEdit.markdownEditor']});
  });

  it('matches the .md extension case-insensitively', () => {
    const ed = openEditor('');
    ed.send({type: 'openFile', src: '../README.MD'});
    expect(lastCommand()).toMatchObject({command: 'vscode.openWith', fsPath: path.resolve(DOC_DIR, '../README.MD')});
  });

  it('uses the default editor for .md when openMdLinksIn is systemDefault', () => {
    const ed = openEditor('', {config: {openMdLinksIn: 'systemDefault'}});
    ed.send({type: 'openFile', src: 'other.md'});
    expect(lastCommand()).toEqual({command: 'vscode.open', fsPath: path.join(DOC_DIR, 'other.md'), rest: []});
  });

  it('uses the default editor for other files', () => {
    const ed = openEditor('');
    ed.send({type: 'openFile', src: 'diagram.drawio'});
    expect(lastCommand()).toMatchObject({command: 'vscode.open', fsPath: path.join(DOC_DIR, 'diagram.drawio')});
  });

  it('passes absolute paths through', () => {
    const abs = path.resolve('/elsewhere/x.png');
    const ed = openEditor('');
    ed.send({type: 'openFile', src: abs});
    expect(lastCommand()).toMatchObject({command: 'vscode.open', fsPath: abs});
  });
});

describe('draw.io files', () => {
  it('replies with the file content', async () => {
    const ed = openEditor('');
    fake.files.set(path.join(DOC_DIR, 'd.drawio'), '<mxfile/>');
    ed.send({type: 'readDrawioFile', src: 'd.drawio', id: 'n1'});
    await tick();
    expect(ed.postedOf('drawioFileContent')).toEqual([{type: 'drawioFileContent', id: 'n1', xml: '<mxfile/>'}]);
  });

  it('replies with an error when the file cannot be read', async () => {
    const ed = openEditor('');
    ed.send({type: 'readDrawioFile', src: 'missing.drawio', id: 'n2'});
    await tick();
    expect(ed.postedOf('drawioFileError')).toEqual([{type: 'drawioFileError', id: 'n2', error: expect.stringContaining('ENOENT')}]);
  });

  it('creates a blank diagram and replies with a forward-slash relative path', async () => {
    const ed = openEditor('');
    const target = path.join(DOC_DIR, 'sub', 'new.drawio');
    fake.saveDialogResult = Uri.file(target);
    ed.send({type: 'insertDrawio'});
    await tick();
    expect(fake.writtenFiles.get(target)).toContain('<mxGraphModel');
    expect(ed.postedOf('drawioFileCreated')).toEqual([{type: 'drawioFileCreated', src: 'sub/new.drawio'}]);
  });

  it('does nothing when the save dialog is cancelled', async () => {
    const ed = openEditor('');
    ed.send({type: 'insertDrawio'});
    await tick();
    expect(fake.writtenFiles.size).toBe(0);
    expect(ed.postedOf('drawioFileCreated')).toEqual([]);
  });
});

describe('other messages', () => {
  it('openSettings opens the extension settings', () => {
    const ed = openEditor('');
    ed.send({type: 'openSettings'});
    expect(fake.executedCommands).toEqual([{command: 'workbench.action.openSettings', args: ['@ext:GeorgeSamartzidis.gravity-edit']}]);
  });

  it('asks the webview to reload images when the panel becomes visible or the window regains focus', () => {
    const ed = openEditor('');
    ed.showPanel();
    fake.onDidChangeWindowState.fire({focused: true});
    fake.onDidChangeWindowState.fire({focused: false});
    expect(ed.postedOf('reloadImages')).toHaveLength(2);
  });

  it('does not reload images for a hidden panel', () => {
    const ed = openEditor('');
    ed.panel.visible = false;
    ed.showPanel();
    fake.onDidChangeWindowState.fire({focused: true});
    expect(ed.postedOf('reloadImages')).toEqual([]);
  });
});
