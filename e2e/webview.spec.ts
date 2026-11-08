// Webview behaviour in a real browser: edit posting and the save handshake, external updates,
// undo, mode switching, link routing, popups vs the sticky toolbar, draw.io, and CSP.
import {expect, test, type Page} from '@playwright/test';

import {openEditor, readRepoFile} from './webview';

const DEBOUNCE_MS = 300; // EDIT_DEBOUNCE_MS in webview-ui/src/Editor.tsx

/** Put the caret at the end of the first paragraph. */
async function caretToEndOfFirstParagraph(editor: ReturnType<Page['locator']>, page: Page) {
  await editor.locator('p').first().click();
  await page.keyboard.press('End');
}

test.describe('posting edits', () => {
  test('opening a file posts no edit (it must not look modified)', async ({page}) => {
    const wv = await openEditor(page, 'Hello\n\nWorld\n');
    await page.waitForTimeout(DEBOUNCE_MS * 2);
    expect((await wv.posted()).map((m) => m.type)).toEqual(['ready']);
  });

  test('typing posts one debounced edit with the whole document', async ({page}) => {
    const wv = await openEditor(page, 'Hello\n\nWorld\n');
    await caretToEndOfFirstParagraph(wv.editor, page);
    await page.keyboard.type('abc', {delay: 30});
    // One message for three keystrokes is the debounce at work.
    await expect.poll(async () => (await wv.postedOf('edit')).length).toBe(1);
    await page.waitForTimeout(DEBOUNCE_MS * 2);
    expect(await wv.postedOf('edit')).toEqual([{type: 'edit', text: 'Helloabc\n\nWorld'}]);
  });

  test('a save-time flush returns pending typing and cancels the debounced edit', async ({page}) => {
    const wv = await openEditor(page, 'Hello\n\nWorld\n');
    await caretToEndOfFirstParagraph(wv.editor, page);
    await page.keyboard.type('xyz');
    expect(await wv.flush()).toBe('Helloxyz\n\nWorld');
    await page.waitForTimeout(DEBOUNCE_MS * 2);
    expect(await wv.postedOf('edit')).toEqual([]);
  });

  test('edits and flushes include the frontmatter, which is not shown in the editor', async ({page}) => {
    const wv = await openEditor(page, '---\ntitle: T\n---\nHello\n');
    await expect(wv.editor).not.toContainText('title');
    await caretToEndOfFirstParagraph(wv.editor, page);
    await page.keyboard.type('!');
    await expect.poll(async () => (await wv.postedOf('edit')).map((m) => m.text)).toEqual(['---\ntitle: T\n---\nHello!']);
    expect(await wv.flush()).toBe('---\ntitle: T\n---\nHello!');
  });
});

test.describe('updates from the extension', () => {
  test('an external change replaces the content without posting an edit back', async ({page}) => {
    const wv = await openEditor(page, 'Hello\n');
    await wv.send({type: 'update', text: '# New heading\n', docDir: '/docs'});
    await expect(wv.editor.locator('h1')).toHaveText('New heading');
    await page.waitForTimeout(DEBOUNCE_MS * 2);
    expect(await wv.postedOf('edit')).toEqual([]);
  });

  test('the echo of our own edit leaves the caret where it was (regression: cursor jumps)', async ({page}) => {
    const wv = await openEditor(page, 'Hello\n\nWorld\n');
    await caretToEndOfFirstParagraph(wv.editor, page);
    await page.keyboard.type('abc');
    await expect.poll(async () => (await wv.postedOf('edit')).length).toBe(1);
    const [{text}] = await wv.postedOf('edit');
    await wv.send({type: 'update', text, docDir: '/docs'}); // what onDidChangeTextDocument would echo
    await page.waitForTimeout(100);
    await page.keyboard.type('d');
    expect(await wv.flush()).toBe('Helloabcd\n\nWorld');
  });

  test('a new draw.io file is inserted as a drawio fence', async ({page}) => {
    const wv = await openEditor(page, 'Hello\n');
    await caretToEndOfFirstParagraph(wv.editor, page);
    await wv.send({type: 'drawioFileCreated', src: 'diagrams/new.drawio'});
    await expect.poll(() => wv.flush()).toContain('```drawio\ndiagrams/new.drawio\n```');
    expect((await wv.postedOf('readDrawioFile')).map((m) => m.src)).toEqual(['diagrams/new.drawio']);
  });

  test('reloadImages cache-busts image URLs', async ({page}) => {
    const wv = await openEditor(page, '![pic](pic.png)\n');
    await wv.send({type: 'reloadImages'});
    await expect(wv.editor.locator('img').first()).toHaveAttribute('src', /[?&]_t=\d+/);
  });
});

test.describe('undo', () => {
  test('Ctrl+Z right after opening does not empty the document', async ({page}) => {
    const wv = await openEditor(page, 'Hello\n\nWorld\n');
    await wv.editor.locator('p').first().click();
    await page.keyboard.press('Control+z');
    expect(await wv.flush()).toBe('Hello\n\nWorld');
  });

  test('Ctrl+Z undoes typing', async ({page}) => {
    const wv = await openEditor(page, 'Hello\n');
    await caretToEndOfFirstParagraph(wv.editor, page);
    await page.keyboard.type('abc');
    await page.keyboard.press('Control+z');
    expect(await wv.flush()).toBe('Hello');
  });
});

test.describe('editor modes', () => {
  test('defaultMode "markup" opens the raw markdown editor', async ({page}) => {
    const wv = await openEditor(page, '# Title\n\nText\n', {config: {defaultMode: 'markup'}});
    await expect(wv.editor).toContainText('# Title');
    expect(await wv.flush()).toBe('# Title\n\nText\n');
  });

  test('switching modes does not post an edit (regression: document marked dirty)', async ({page}) => {
    const wv = await openEditor(page, 'Hello\n\nWorld\n');
    const switchTo = async (mode: 'markup' | 'wysiwyg') => {
      await page.locator('[data-qa="g-md-settings-button"]').click();
      await page.locator(`[data-qa="g-md-settings-mode-${mode}"]`).click();
    };
    await switchTo('markup');
    await expect(page.locator('.cm-content')).toContainText('Hello');
    await switchTo('wysiwyg');
    await expect(page.locator('.ProseMirror')).toContainText('World');
    await page.waitForTimeout(DEBOUNCE_MS * 2);
    expect(await wv.postedOf('edit')).toEqual([]);
  });
});

test.describe('table insertion follows gravityEdit.newTableFormat (ADR-006)', () => {
  for (const [format, marker] of [['gfm', '|:---|'], ['yfm', '#|']] as const) {
    test(`toolbar button inserts ${format}`, async ({page}) => {
      const wv = await openEditor(page, 'Hello\n', {config: {newTableFormat: format}});
      await caretToEndOfFirstParagraph(wv.editor, page);
      await page.getByRole('button', {name: 'Table', exact: true}).click();
      expect(await wv.flush()).toContain(marker);
    });

    test(`slash menu inserts ${format}`, async ({page}) => {
      const wv = await openEditor(page, 'Hello\n', {config: {newTableFormat: format}});
      await caretToEndOfFirstParagraph(wv.editor, page);
      await page.keyboard.press('Enter');
      await page.keyboard.type('/');
      await page.locator('.g-md-command-menu__item_id_table').click();
      expect(await wv.flush()).toContain(marker);
    });
  }

  test('enableSlashCommands=false: "/" opens no menu', async ({page}) => {
    const wv = await openEditor(page, 'Hello\n', {config: {enableSlashCommands: false}});
    await caretToEndOfFirstParagraph(wv.editor, page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    await page.waitForTimeout(300);
    await expect(page.locator('.g-md-command-menu')).toHaveCount(0);
  });
});

test.describe('links', () => {
  test('a plain click on a link in the content only moves the caret', async ({page}) => {
    const wv = await openEditor(page, 'See [site](https://example.com/) and [doc](other.md)\n');
    const url = page.url();
    await wv.editor.locator('a', {hasText: 'site'}).click();
    await wv.editor.locator('a', {hasText: 'doc'}).click();
    await page.waitForTimeout(200);
    expect(page.url()).toBe(url);
    expect(await wv.postedOf('openExternal')).toEqual([]);
    expect(await wv.postedOf('openFile')).toEqual([]);
  });

  // target="_blank" anchors (the library's follow-link and Documentation buttons) are dead in a
  // VS Code webview (no allow-popups), so Editor.tsx forwards them to the extension (ADR-007/013).
  async function clickBlankAnchor(page: Page, href: string) {
    await page.evaluate((h) => {
      const a = document.createElement('a');
      a.href = h;
      a.target = '_blank';
      a.textContent = 'follow';
      a.id = 'e2e-anchor';
      document.body.prepend(a);
    }, href);
    await page.locator('#e2e-anchor').click();
  }

  test('a relative target="_blank" link opens the local file (decoded, without #fragment)', async ({page}) => {
    const wv = await openEditor(page, 'Hello\n');
    await clickBlankAnchor(page, 'other%20file.md#section');
    expect(await wv.postedOf('openFile')).toEqual([{type: 'openFile', src: 'other file.md'}]);
    expect(await wv.postedOf('openExternal')).toEqual([]);
  });

  test('an absolute target="_blank" link is handed to openExternal', async ({page}) => {
    const wv = await openEditor(page, 'Hello\n');
    await clickBlankAnchor(page, 'https://example.com/docs?x=1');
    expect(await wv.postedOf('openExternal')).toEqual([{type: 'openExternal', url: 'https://example.com/docs?x=1'}]);
    expect(await wv.postedOf('openFile')).toEqual([]);
  });
});

test.describe('popups vs the sticky toolbar', () => {
  // The toolbar is z-index 2000 and default popups 1000; webviewHtml.ts lifts specific popups.
  // These check the CSS selectors still match the library's current DOM.
  const zIndexOfPopup = (page: Page, selector: string) =>
    page.evaluate((sel) => {
      const root = document.querySelector(sel)?.closest('div[data-floating-ui-placement]');
      return root ? getComputedStyle(root).zIndex : null;
    }, selector);

  test('Ctrl+F search panel', async ({page}) => {
    const wv = await openEditor(page, 'Hello\n');
    await wv.editor.locator('p').first().click();
    await page.keyboard.press('Control+f');
    await expect(page.locator('[data-qa="g-md-search-panel"]')).toBeVisible();
    expect(await zIndexOfPopup(page, '[data-qa="g-md-search-panel"]')).toBe('10000');
  });

  test('toolbar insert-image form', async ({page}) => {
    const wv = await openEditor(page, 'Hello\n');
    await caretToEndOfFirstParagraph(wv.editor, page);
    await page.getByRole('button', {name: 'Image', exact: true}).click();
    await expect(page.locator('.g-md-image-form').first()).toBeVisible();
    expect(await zIndexOfPopup(page, '.g-md-image-form')).toBe('10000');
  });
});

test.describe('draw.io and page health', () => {
  test('a file-based diagram is requested from the extension and rendered', async ({page}) => {
    const wv = await openEditor(page, '```drawio\n./diagram.drawio\n```\n');
    await expect.poll(async () => (await wv.postedOf('readDrawioFile')).length).toBe(1);
    const [req] = await wv.postedOf('readDrawioFile');
    expect(req.src).toBe('./diagram.drawio');
    await wv.send({type: 'drawioFileContent', id: req.id, xml: readRepoFile('e2e/fixtures/diagram.drawio')});
    await expect(wv.editor.locator('.mxgraph svg').first()).toBeVisible();
  });

  test('a read error is shown in place of the diagram', async ({page}) => {
    const wv = await openEditor(page, '```drawio\nmissing.drawio\n```\n');
    await expect.poll(async () => (await wv.postedOf('readDrawioFile')).length).toBe(1);
    const [req] = await wv.postedOf('readDrawioFile');
    await wv.send({type: 'drawioFileError', id: req.id, error: 'ENOENT'});
    await expect(wv.editor).toContainText('Draw.io error: ENOENT');
  });

  test('sample.md renders with no script errors and only the known CSP blocks', async ({page}) => {
    const wv = await openEditor(page, readRepoFile('e2e/fixtures/sample.md'));
    await expect.poll(async () => (await wv.postedOf('readDrawioFile')).length).toBe(1);
    const [req] = await wv.postedOf('readDrawioFile');
    await wv.send({type: 'drawioFileContent', id: req.id, xml: readRepoFile('e2e/fixtures/diagram.drawio')});
    await expect(wv.editor.locator('.mxgraph svg').first()).toBeVisible();
    await expect(wv.editor.locator('svg[id^="mermaid"], .mermaid svg').first()).toBeVisible();
    await page.waitForTimeout(500);
    expect(wv.pageErrors).toEqual([]);
    // The draw.io viewer tries to pull MathJax and a Google font from the internet; the CSP
    // blocks both (accepted - diagrams render without them). Anything else is new.
    const unexpected = (await wv.cspViolations()).filter((v) =>
      !v.startsWith('script-src-elem https://viewer.diagrams.net/') &&
      !v.startsWith('style-src-elem https://fonts.googleapis.com/'));
    expect(unexpected).toEqual([]);
  });
});
