import fs from 'fs';
import os from 'os';
import path from 'path';

import {defineConfig} from '@vscode/test-cli';

// Integration tests run inside a real VS Code (downloaded into .vscode-test/ on first run)
// against a throwaway workspace in the system temp folder, recreated on every run.
// VSCODE_TEST_VERSION picks the VS Code build, e.g. `1.85.0` (the oldest in engines.vscode).
const workspace = path.join(os.tmpdir(), 'gravity-edit-it-workspace');
fs.rmSync(workspace, {recursive: true, force: true});
fs.mkdirSync(workspace, {recursive: true});

export default defineConfig({
  files: 'out-integration/**/*.test.js',
  version: process.env.VSCODE_TEST_VERSION ?? 'stable',
  // The real path: os.tmpdir() can be a Windows 8.3 short path that VS Code reports differently.
  workspaceFolder: fs.realpathSync.native(workspace),
  launchArgs: ['--disable-extensions', '--disable-gpu'],
  mocha: {ui: 'tdd', timeout: 20000},
});
