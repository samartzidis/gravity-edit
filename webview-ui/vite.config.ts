import {resolve} from 'path';

import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, '../out/webview'),
    emptyOutDir: true,
    // CSS is injected at runtime via a JS <style> tag (no separate main.css / <link>), so any
    // asset URLs Vite emits as files resolve against the document's <base href> - which is
    // pinned to the markdown file's own folder for image loading, not to out/webview. Font
    // files (e.g. KaTeX, pulled in by the Math extension) would 404. Inlining them as data:
    // URIs sidesteps URL resolution entirely; the webview CSP already allows `font-src ... data:`.
    assetsInlineLimit: 1024 * 1024,
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
