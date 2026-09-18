import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

// Read the repo-root .env so the proxy follows API_PORT. Without this the
// dashboard silently proxies to the wrong port whenever the API is moved --
// which happens on any machine where something else already holds 3000.
loadEnv({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
const apiPort = process.env.API_PORT ?? '3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The dashboard talks to the API on the same origin in production; in dev
    // it proxies so the admin token never needs CORS handling.
    proxy: { '/api': { target: process.env.API_URL ?? `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
