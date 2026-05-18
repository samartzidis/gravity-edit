"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = require("path");
const plugin_react_1 = __importDefault(require("@vitejs/plugin-react"));
const vite_1 = require("vite");
exports.default = (0, vite_1.defineConfig)({
    plugins: [(0, plugin_react_1.default)()],
    build: {
        outDir: (0, path_1.resolve)(__dirname, '../out/webview'),
        emptyOutDir: true,
        rollupOptions: {
            input: (0, path_1.resolve)(__dirname, 'src/main.tsx'),
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
