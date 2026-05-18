import {resolve} from 'path';

import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, '../out/webview'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/main.tsx'),
      output: {
        // Single predictable filenames so the extension can construct the URIs.
        format: 'iife',
        entryFileNames: 'main.js',
        assetFileNames: '[name][extname]',
        // Inline all dynamic imports into one bundle.
        inlineDynamicImports: true,
      },
    },
  },
});
