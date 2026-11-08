// Generates realistic Markdown of roughly the requested size: headings, paragraphs with inline
// formatting, lists, a GFM table and a code block, repeated with numbered sections.
// Shared by integration/timings.test.ts and e2e/timings.spec.ts.

const SECTION = (n: number) => `## Section ${n}

This is paragraph ${n} with **bold**, *italic*, \`inline code\` and a [link](https://example.com/${n}).
It goes on for a while so the line is about as long as real prose usually is, give or take.

- item one of section ${n}
- item two with \`code\`
  - a nested item

| Column A | Column B | Column C |
|---|---|---|
| a${n} | b${n} | c${n} |
| d${n} | e${n} | f${n} |

\`\`\`ts
const value${n} = compute(${n});
\`\`\`

`;

export function largeMarkdown(bytes: number): string {
  const parts = ['# Large document\n\n'];
  let size = parts[0].length;
  for (let n = 1; size < bytes; n++) {
    const s = SECTION(n);
    parts.push(s);
    size += s.length;
  }
  return parts.join('');
}

export function formatSize(bytes: number): string {
  return bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
