import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome120',
    minify: false,
    lib: {
      entry: resolve(__dirname, 'src/page-fetch.ts'),
      name: 'pageFetch',
      formats: ['iife'],
      fileName: () => 'page-fetch.js',
    },
    rollupOptions: {
      output: {
        extend: true,
      },
    },
  },
});
