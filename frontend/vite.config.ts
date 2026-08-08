import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Must mirror the `paths` entry in tsconfig.json. tsc resolves the alias
    // from tsconfig alone, so without this the types check but the dev server
    // cannot resolve a single import.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // The browser talks only to this dev server; /api is proxied to the
    // connector API. Credentials therefore never reach client code — the
    // frontend has no way to hold one even by accident.
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Split vendor code so the app shell loads without waiting on
        // libraries that only some routes need.
        manualChunks: (id: string): string | undefined => {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) {
            return 'react';
          }
          if (id.includes('@tanstack')) return 'query';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
  },
});
