// @vitest-environment node
import { it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

it('keeps QA and application data in DATA_DIR when optional directory variables are empty', async () => {
  const data = join(tmpdir(), 'matrix-data-directory');
  vi.stubEnv('DATA_DIR', data);
  vi.stubEnv('SYNC_DATA_DIR', '');
  vi.resetModules();
  try {
    const paths = await import('../runtime-paths');
    expect(paths.dataDir).toBe(data);
    expect(paths.greyDataDir).toBe(data);
  } finally { vi.unstubAllEnvs(); vi.resetModules(); }
});
