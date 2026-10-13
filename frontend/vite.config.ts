import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const frontendRoot = fileURLToPath(new URL('.', import.meta.url));
const backendTarget = process.env.BACKEND_URL ?? 'http://127.0.0.1:4174';
const proxy = {
  '/api': { target: backendTarget, ws: true },
  '/mcp': { target: backendTarget, ws: true }
};

export default defineConfig({
  root: frontendRoot,
  plugins: [react()],
  server: { fs: { allow: [frontendRoot] }, proxy },
  preview: { proxy }
});
