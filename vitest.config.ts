import * as path from 'path';

import {defineConfig} from 'vitest/config';

// Extension-host tests. There is no real 'vscode' module outside VS Code, so it is aliased to
// a fake (test/fakeVscode.ts) that the tests drive. Webview tests live in webview-ui/ and run
// with their own config.
export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'test/fakeVscode.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
