import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('..', import.meta.url)),
    include: ['backend/server/**/*.{test,spec}.{js,ts,jsx,tsx}'],
    testTimeout: 15000,
    environment: 'jsdom',
    globals: true
  }
});
