import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { bundleLimits } from './scripts/limits.ts';

export default defineConfig({
  plugins: [react(), tailwindcss(), bundleLimits(import.meta.dirname)],
  build: {
    target: 'es2022',
    sourcemap: false, // keep the sideload zip lean (share.mjs skips .map files anyway)
  },
  server: {
    host: true,
  },
});
