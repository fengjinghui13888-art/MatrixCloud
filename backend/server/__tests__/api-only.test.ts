// @vitest-environment node
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, vi } from 'vitest';
import request from 'supertest';

it('serves API health but never exposes a frontend index or static asset', async () => {
  const root = mkdtempSync(join(tmpdir(), 'matrix-api-only-'));
  writeFileSync(join(root, 'index.html'), '<html>frontend private fixture</html>');
  writeFileSync(join(root, 'asset.txt'), 'frontend asset fixture');
  vi.stubEnv('DIST_DIR', root);
  vi.resetModules();
  try {
    const { createGreyApp } = await import('../grey-app');
    const { createStore } = await import('../store');
    const app = createGreyApp(createStore(join(root, 'ops.sqlite')), 'test-only-access-token-32-characters');
    expect((await request(app).get('/api/health')).status).toBe(200);
    expect((await request(app).get('/')).status).toBe(404);
    expect((await request(app).get('/asset.txt')).status).toBe(404);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
