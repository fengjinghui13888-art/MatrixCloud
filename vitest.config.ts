import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['frontend/src/**/*.{test,spec}.{js,ts,jsx,tsx}', 'backend/server/**/*.{test,spec}.{js,ts,jsx,tsx}', 'local-connector/**/*.{test,spec}.{js,mjs}'],
    testTimeout: 15000,
    environment: 'jsdom',
    setupFiles: ['frontend/src/test-setup.ts'],
    globals: true
  }
});
