import {defineConfig, devices} from '@playwright/test';

// Browser tests of the built webview bundle (out/webview/main.js) - run `npm run build:all`
// first. Each test loads the extension's real webview HTML (src/webviewHtml.ts) from a
// routed fake origin, with a stand-in for acquireVsCodeApi; see e2e/webview.ts.
export default defineConfig({
  testDir: 'e2e',
  testIgnore: 'timings.spec.ts', // measurements only: npm run test:timings (playwright.timings.config.ts)
  globalSetup: './e2e/globalSetup.ts',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    viewport: {width: 1000, height: 800},
    trace: 'retain-on-failure',
  },
});
