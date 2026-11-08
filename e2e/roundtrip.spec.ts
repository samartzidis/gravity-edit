// Markdown fidelity: what the real editor writes back when a file is opened and saved. Each
// case loads text through the extension's 'update' message and reads the result back through
// the save-time 'requestFlush' handshake, then saves that result again to check it is stable.
import {expect, test, type Page} from '@playwright/test';

import {readRepoFile, roundTrip, type OpenOptions} from './webview';

const BS = '\\';

/** Text after open + save; asserts a second open + save changes nothing further. */
async function save(page: Page, text: string, opts?: OpenOptions): Promise<string> {
  const once = await roundTrip(page, text, opts);
  const twice = await roundTrip(await page.context().newPage(), once, opts);
  expect(twice, 'saving the saved text again should not change it').toBe(once);
  return once;
}

const withoutFinalNewline = (s: string) => s.replace(/\n+$/, '');

test.describe('kept as written', () => {
  // Most blocks lose the file's final newline (see 'known normalizations'); fenced and HTML
  // blocks keep theirs, so those cases pass keepFinalNewline.
  const cases: [name: string, text: string, keepFinalNewline?: boolean][] = [
    ['YAML frontmatter (ADR-020)', '---\ntitle: AD\ntags: [a, b]\n---\n# Title\n\nText\n'],
    ['empty frontmatter (Jekyll)', '---\n---\n# Hi\n'],
    ['&nbsp; blank lines (preserveEmptyLines)', 'First\n\n&nbsp;\n\n&nbsp;\n\nSecond\n'],
    ['[[_TOC_]] directive, not escaped', '[[_TOC_]]\n\n# Heading\n'],
    ['draw.io file reference', '```drawio\n./diagram.drawio\n```\n', true],
    ['inline draw.io XML', '```drawio\n<mxfile><diagram name="P"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>\n```\n', true],
    ['mermaid', '```mermaid\ngraph TD\n  A --> B\n```\n', true],
    ['links and images with percent-encoded paths', '[doc](other%20file.md#sec) and ![img](images/my%20pic.png)\n'],
    ['nested and ordered lists', '- a\n- b\n  - c\n\n1. one\n2. two\n'],
    ['inline formatting', '**bold** *it* `code` ~~del~~\n'],
    ['code fence with language', '```ts\nconst a = 1;\n```\n'],
    ['raw HTML block', '<div align="center">x</div>\n', true],
    ['already-escaped literals', `Use ${BS}* and ${BS}_ literally, snake_case, a # b\n`],
  ];

  for (const [name, text, keepFinalNewline] of cases) {
    test(name, async ({page}) => {
      expect(await save(page, text)).toBe(keepFinalNewline ? text : withoutFinalNewline(text));
    });
  }
});

test.describe('tables', () => {
  test('<br> inside a GFM cell stays a line break, not a row break', async ({page}) => {
    const out = await save(page, '| a | b |\n| --- | --- |\n| line1<br>line2 | x |\n');
    expect(out).toContain('|line1<br>line2|x|');
  });

  test('GFM tables stay GFM', async ({page}) => {
    const out = await save(page, '| a | b |\n| --- | --- |\n| 1 | 2 |\n');
    expect(out).toMatch(/^\|a\|b\|$/m);
    expect(out).not.toContain('#|');
  });

  test('YFM tables stay YFM', async ({page}) => {
    const out = await save(page, '#|\n|| a | b ||\n|| 1 | 2 ||\n|#\n');
    expect(out.startsWith('#|\n')).toBe(true);
    expect(out).toContain('|#');
  });

  test('a YFM cell keeps math that contains |', async ({page}) => {
    const out = await save(page, '#|\n|| $|x|$ | y ||\n|#\n');
    expect(out).toContain('$|x|$');
    expect(out).toContain('\ny\n');
  });

  // GFM requires a `|` inside a cell to be written `\|`, even inside code or math. These used
  // to be saved unescaped, so the next open split the cell and the second save lost the column.
  test(`a GFM cell keeps math that contains ${BS}|`, async ({page}) => {
    expect(await save(page, `| a | b |\n| --- | --- |\n| $${BS}|x${BS}|$ | y |\n`))
      .toContain(`|$${BS}|x${BS}|$|y|`);
  });

  test(`a GFM cell keeps inline code that contains ${BS}|`, async ({page}) => {
    expect(await save(page, `| a | b |\n| --- | --- |\n| \`a${BS}|b\` | y |\n`))
      .toContain(`|\`a${BS}|b\`|y|`);
  });

  test(`a GFM cell keeps a plain-text ${BS}|`, async ({page}) => {
    expect(await save(page, `| a | b |\n| --- | --- |\n| a ${BS}| b | y |\n`))
      .toContain(`|a ${BS}| b|y|`);
  });

  test('an unescaped | inside math in a GFM cell splits the cell, as GitHub does (invalid GFM)', async ({page}) => {
    // Cells "$", "x", "$", "y" against a 2-column header: the extras are dropped per the spec.
    expect(await save(page, '| a | b |\n| --- | --- |\n| $|x|$ | y |\n')).toContain(`|${BS}$|x|`);
  });
});

test.describe('math', () => {
  test('inline and block math keep their backslashes (not markdown-escaped)', async ({page}) => {
    const out = await save(page, `Inline $E=mc^2$ here.\n\n$$\n${BS}int_0^1 x${BS},dx\n$$\n`);
    expect(out).toContain('$E=mc^2$');
    expect(out).toContain(`${BS}int_0^1 x${BS},dx`);
  });
});

// The serializer's own formatting. Not data loss, but each shows up as a diff the first time a
// file is saved from Gravity Editor. These pin today's output so a library upgrade that changes
// it is noticed; update the expectation if the new output is acceptable.
test.describe('known normalizations', () => {
  test('the final newline is dropped (except after fenced and HTML blocks)', async ({page}) => {
    expect(await save(page, 'Text\n')).toBe('Text');
  });

  test('GFM tables are compacted, get explicit left alignment and a leading blank line', async ({page}) => {
    expect(await save(page, '| a | b |\n| --- | --- |\n| 1 | 2 |\n')).toBe('\n|a|b|\n|:---|:---|\n|1|2|\n');
  });

  test('GFM column alignment is kept', async ({page}) => {
    expect(await save(page, '| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n')).toBe('\n|a|b|c|\n|:---|:---:|---:|\n|1|2|3|\n');
  });

  test('the blank line after frontmatter is dropped', async ({page}) => {
    expect(await save(page, '---\ntitle: AD\n---\n\n# Title\n')).toBe('---\ntitle: AD\n---\n# Title');
  });

  test('block math is laid out as $$…\\n$$', async ({page}) => {
    expect(await save(page, `$$\n${BS}int x\n$$\n`)).toBe(`$$${BS}int x\n$$\n\n`);
  });

  test('single square brackets are escaped', async ({page}) => {
    expect(await save(page, '[note] see [x](y)\n')).toBe(`${BS}[note${BS}] see [x](y)`);
  });

  test('demo.md: only the blank lines after the drawio/mermaid fences and the final newline change', async ({page}) => {
    const text = readRepoFile('demo/demo.md');
    const expected = withoutFinalNewline(text)
      .replace('```\n\n```mermaid', '```\n```mermaid')
      .replace('```\n\n## Single', '```\n## Single');
    expect(expected).not.toBe(withoutFinalNewline(text)); // the two replacements matched
    expect(await save(page, text, {docFolder: 'demo'})).toBe(expected);
  });
});
