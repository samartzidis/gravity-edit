import {defineConfig} from 'vitest/config';

// Standalone from vite.config.ts on purpose: tests don't need the React plugin or the
// bundle/output settings used for the webview build.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
