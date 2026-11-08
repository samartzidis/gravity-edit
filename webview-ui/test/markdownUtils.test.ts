import {describe, expect, it} from 'vitest';

import {
  computeRelativePath,
  encodeMdPath,
  escapeTableCellPipes,
  isAbsolutePath,
  splitFrontmatter,
} from '../src/markdownUtils';

describe('escapeTableCellPipes', () => {
  it.each([
    ['raw pipes in math', '$|x|$', '$\\|x\\|$'],
    ['raw pipe in code', '`a|b`', '`a\\|b`'],
    ['already escaped (plain text)', 'a \\| b', 'a \\| b'],
    ['escaped backslash before a raw pipe', 'a\\\\|b', 'a\\\\\\|b'],
    ['no pipes', 'plain <br> text', 'plain <br> text'],
    ['empty', '', ''],
  ])('%s', (_name, input, expected) => {
    expect(escapeTableCellPipes(input)).toBe(expected);
  });
});

describe('isAbsolutePath', () => {
  it.each(['C:\\docs\\a.png', 'c:/docs/a.png', '/home/u/a.png'])('accepts %s', (p) => {
    expect(isAbsolutePath(p)).toBe(true);
  });

  it.each(['a.png', './a.png', '../a.png', 'C:a.png', ''])('rejects %j', (p) => {
    expect(isAbsolutePath(p)).toBe(false);
  });

  it('does not recognise UNC paths (current behaviour)', () => {
    expect(isAbsolutePath('\\\\server\\share\\a.png')).toBe(false);
  });
});

describe('computeRelativePath', () => {
  it('file in the same folder', () => {
    expect(computeRelativePath('C:\\docs', 'C:\\docs\\a.png')).toBe('a.png');
  });

  it('file in a child folder', () => {
    expect(computeRelativePath('C:\\docs', 'C:\\docs\\img\\a.png')).toBe('img/a.png');
  });

  it('file in a sibling folder', () => {
    expect(computeRelativePath('C:\\docs\\notes', 'C:\\docs\\img\\a.png')).toBe('../img/a.png');
  });

  it('several levels up', () => {
    expect(computeRelativePath('C:\\a\\b\\c', 'C:\\x\\y.md')).toBe('../../../x/y.md');
  });

  it('compares segments case-insensitively (drive letter and folders)', () => {
    expect(computeRelativePath('c:\\Docs', 'C:\\docs\\a.png')).toBe('a.png');
  });

  it('accepts mixed separators and always returns forward slashes', () => {
    expect(computeRelativePath('C:/docs', 'C:\\docs\\img/a.png')).toBe('img/a.png');
  });

  it('POSIX paths', () => {
    expect(computeRelativePath('/home/u/docs', '/home/u/pics/a.png')).toBe('../pics/a.png');
  });

  it('identical paths give "."', () => {
    expect(computeRelativePath('C:\\docs', 'C:\\docs')).toBe('.');
  });
});

describe('encodeMdPath', () => {
  it('leaves a plain relative path unchanged', () => {
    expect(encodeMdPath('../img/a.png')).toBe('../img/a.png');
  });

  it('encodes spaces', () => {
    expect(encodeMdPath('img/my pic.png')).toBe('img/my%20pic.png');
  });

  it('encodes parentheses, which encodeURI leaves alone', () => {
    expect(encodeMdPath('a (1).png')).toBe('a%20%281%29.png');
  });

  it('encodes #, which would otherwise start a fragment', () => {
    expect(encodeMdPath('notes#1.md')).toBe('notes%231.md');
  });

  it('encodes % and non-ASCII characters', () => {
    expect(encodeMdPath('50%.png')).toBe('50%25.png');
    expect(encodeMdPath('ü.md')).toBe('%C3%BC.md');
  });
});

describe('splitFrontmatter', () => {
  const cases: [name: string, input: string, frontmatter: string][] = [
    ['--- closer', '---\ntitle: AD\n---\n# Hi\n', '---\ntitle: AD\n---\n'],
    ['... closer', '---\na: 1\n...\nbody', '---\na: 1\n...\n'],
    ['trailing whitespace on the fences', '--- \na: 1\n---\t\nbody', '--- \na: 1\n---\t\n'],
    ['closer at end of file without a newline', '---\na: 1\n---', '---\na: 1\n---'],
    ['empty block (Jekyll)', '---\n---\n# Hi\n', '---\n---\n'],
    ['empty block with ... closer', '---\n...\nbody', '---\n...\n'],
    ['empty block at end of file', '---\n---', '---\n---'],
    ['multi-line YAML', '---\na: 1\nlist:\n  - x\n  - y\n---\n\nText\n', '---\na: 1\nlist:\n  - x\n  - y\n---\n'],
    ['no frontmatter', '# Title\n\nText\n', ''],
    ['fence not on the first line', '\n---\na: 1\n---\n', ''],
    ['fence after text', 'text\n---\na: 1\n---\n', ''],
    ['empty document', '', ''],
  ];

  it.each(cases)('%s', (_name, input, frontmatter) => {
    const result = splitFrontmatter(input);
    expect(result.frontmatter).toBe(frontmatter);
    // Invariant the editor relies on: getFullValue() = frontmatter + body reproduces the file.
    expect(result.frontmatter + result.body).toBe(input);
  });

  it('expects LF input: CRLF frontmatter is not recognised (the extension host normalizes to LF first)', () => {
    expect(splitFrontmatter('---\r\na: 1\r\n---\r\nbody').frontmatter).toBe('');
  });

  it('treats a document that opens with two thematic breaks as frontmatter (known limitation: kept verbatim, hidden from WYSIWYG)', () => {
    const input = '---\n\nParagraph\n\n---\n\nMore\n';
    expect(splitFrontmatter(input)).toEqual({frontmatter: '---\n\nParagraph\n\n---\n', body: '\nMore\n'});
  });

  it('does not treat a longer dash line as a fence', () => {
    expect(splitFrontmatter('----\na: 1\n---\n').frontmatter).toBe('');
  });
});
