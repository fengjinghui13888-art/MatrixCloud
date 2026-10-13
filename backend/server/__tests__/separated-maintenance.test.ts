// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { it, expect } from 'vitest';
import { maintenanceRunner } from '../maintenance-runner';

it('refuses the legacy single-container publication for a separated workspace before invoking Docker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'matrix-separated-maintenance-'));
  try {
    mkdirSync(join(root, 'frontend'));
    mkdirSync(join(root, 'backend'));
    writeFileSync(join(root, 'frontend/package.json'), '{}');
    writeFileSync(join(root, 'backend/package.json'), '{}');
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'fixture lock');
    writeFileSync(join(root, 'helper.py'), '');
    const run = maintenanceRunner({
      checksImage: 'sha256:' + 'a'.repeat(64),
      lockHash: createHash('sha256').update('fixture lock').digest('hex'),
      deployHelper: join(root, 'helper.py'), backupRoot: root,
      postgres: false, container: 'matrix-separated'
    });
    await expect(run('build', { directory: root, commit: 'b'.repeat(40) }))
      .rejects.toThrow('前后端分离版本');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
