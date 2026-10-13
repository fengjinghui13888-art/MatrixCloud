import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:4174' } },
  test: { testTimeout:15000, exclude:[...configDefaults.exclude,'work/**','outputs/**','.handoff/**'], environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], globals: true }
});
