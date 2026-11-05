/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const web = resolve(__dirname, 'web');

export default defineConfig({
  root: web,
  base: './',
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    outDir: resolve(__dirname, 'build/web'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1500,   // OpenCC 字典約 1.2 MB，只在字幕視窗載入
    rollupOptions: {
      input: { overlay: resolve(web, 'overlay.html'), panel: resolve(web, 'panel.html') },
    },
  },
  test: { root: __dirname, include: ['tests/**/*.test.ts'] },
});
