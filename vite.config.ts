/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync } from 'fs';

function copyStaticFiles(): Plugin {
  return {
    name: 'copy-extension-files',
    closeBundle() {
      const dist = resolve(__dirname, 'dist');
      mkdirSync(dist, { recursive: true });
      copyFileSync(resolve(__dirname, 'manifest.json'), resolve(dist, 'manifest.json'));
      copyFileSync(resolve(__dirname, 'rules.json'), resolve(dist, 'rules.json'));
    },
  };
}

export default defineConfig({
  root: 'src',
  base: '',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    minify: false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup.html'),
        background: resolve(__dirname, 'src/background.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
  test: {
    include: [resolve(__dirname, 'test/**/*.test.ts')],
  },
  plugins: [copyStaticFiles()],
});
