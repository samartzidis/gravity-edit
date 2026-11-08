import {defineConfig} from '@playwright/test';

import base from './playwright.config';

// Runs only e2e/timings.spec.ts (webview load/flush durations on large documents), which the
// default config skips. Run `npm run build:all` first, as for the other browser tests.
export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: 'timings.spec.ts',
  retries: 0,
  reporter: 'list',
});
