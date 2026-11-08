// Pure markdown/path helpers used by Editor.tsx. Kept free of React, the editor library and
// the VS Code API so they can be unit-tested in plain Node (see webview-ui/test).

export function isAbsolutePath(s: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(s) || s.startsWith('/');
}

// Percent-encode a relative path for use as a markdown link destination.
// CommonMark forbids raw spaces in destinations, and unbalanced ()/# also break
// or truncate the link in strict parsers, even though the gravity editor's
// lenient markdown-it accepts them.
export function encodeMdPath(p: string): string {
  return encodeURI(p).replace(/[()#]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function computeRelativePath(fromDir: string, toFile: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const a = norm(fromDir).split('/');
  const b = norm(toFile).split('/');
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  const ups = Array(a.length - i).fill('..');
  return [...ups, ...b.slice(i)].join('/') || '.';
}

// YAML frontmatter (`---` ... `---` at the very start) isn't understood by the markdown parser and
// would be mangled on serialize (read as hr + heading). It is split off before the editor sees
// the text and re-attached verbatim when the text is read back. The block may be empty
// (`---` directly followed by `---`, as Jekyll uses to mark a page for processing).
export const FRONTMATTER_RE = /^---[ \t]*\n(?:[\s\S]*?\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/;

// Escape every `|` not already escaped (i.e. not preceded by an odd number of backslashes), for
// the content of a GFM table cell. Already-escaped `\|` from plain text is left as is.
export function escapeTableCellPipes(cell: string): string {
  return cell.replace(/(\\*)\|/g, (m, backslashes: string) =>
    backslashes.length % 2 === 1 ? m : backslashes + '\\|');
}

export function splitFrontmatter(text: string): {frontmatter: string; body: string} {
  const m = FRONTMATTER_RE.exec(text);
  const frontmatter = m ? m[0] : '';
  return {frontmatter, body: text.slice(frontmatter.length)};
}
