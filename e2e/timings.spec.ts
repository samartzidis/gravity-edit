// Measures the webview's share of the save budget on large documents: loading a document
// ('update') and serializing it for a save flush ('requestFlush' -> 'flushResponse', the same
// getValue() the debounced edit runs every 300 ms while typing). The whole save participant -
// gate wait plus this round-trip - must fit SAVE_BUDGET_MS (1 s) in src/MarkdownEditorProvider.ts,
// or the save goes ahead without the last keystrokes.
//
// Printed, not asserted, and not part of `npm run test:e2e`: run `npm run test:timings`.
// Times are taken inside the page, so Playwright's own overhead is excluded; a real webview
// adds the postMessage hop between processes on top.
import {test} from '@playwright/test';

import {formatSize, largeMarkdown, median} from '../integration/largeDoc';
import {openEditor} from './webview';

const SIZES = process.env.TIMING_SIZES ? process.env.TIMING_SIZES.split(',').map((k) => Number(k) * 1024) : [100 * 1024, 300 * 1024];
// At 1 MB the page ran out of memory (3 GB) after several minutes, so it is not a default.
// TIMING_SIZES=100,300,600 (sizes in KB) overrides them.
const RUNS = 3;

test.setTimeout(600_000);

test('webview load and flush timings on large documents', async ({page}) => {
  await openEditor(page, '# small\n');
  const lines = ['', `Webview timings (median of ${RUNS} flushes):`, '  size            load     flush   (save budget: 1000 ms, incl. gate wait)'];

  for (const size of SIZES) {
    const text = largeMarkdown(size);
    const lastSection = (text.match(/const value(\d+)/g) ?? []).at(-1)!;

    // Load: from posting 'update' until the last block is in the DOM.
    const load = await page.evaluate(async ({text, lastSection}) => {
      const t0 = performance.now();
      window.postMessage({type: 'update', text, docDir: ''}, '*');
      const pm = document.querySelector('.ProseMirror')!;
      while (!pm.lastElementChild?.textContent?.includes(lastSection)) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      return performance.now() - t0;
    }, {text, lastSection});

    // Flush: the webview answers synchronously in its message handler, so time from posting
    // the request to the response being handed to acquireVsCodeApi().postMessage.
    const flushes: number[] = [];
    // Type first: a save follows a change, and the editor caches the serialized text until then.
    await page.locator('.ProseMirror').first().click();
    for (let i = 0; i < RUNS; i++) {
      await page.keyboard.type('x');
      flushes.push(await page.evaluate(async (id) => {
        const posted = window.__posted;
        const push = posted.push.bind(posted);
        const t0 = performance.now();
        const done = new Promise<number>((resolve) => {
          posted.push = (...items) => {
            if (items.some((m) => m.type === 'flushResponse' && m.id === id)) resolve(performance.now() - t0);
            return push(...items);
          };
        });
        window.postMessage({type: 'requestFlush', id}, '*');
        const elapsed = await done;
        posted.push = push;
        return elapsed;
      }, 5000 + i));
    }
    lines.push(`  ${formatSize(text.length).padEnd(12)}${`${Math.round(load)} ms`.padStart(9)}${`${Math.round(median(flushes))} ms`.padStart(10)}`);
  }
  console.log(lines.join('\n'));
});
