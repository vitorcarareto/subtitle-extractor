import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome120',
    minify: false,
    lib: {
      entry: resolve(__dirname, 'src/content.ts'),
      name: 'content',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
    rollupOptions: {
      output: {
        // Ensure the IIFE doesn't assign to a global variable
        extend: true,
      },
    },
  },
});
