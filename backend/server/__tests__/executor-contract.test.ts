import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('publish executor core contract', () => {
  it('keeps the verified DataTransfer path and human confirmation boundary', () => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/studio-executor.mjs'), 'utf8');
    expect(source).toContain('new DataTransfer()');
    expect(source).toContain('请检查后由人工点击发布');
    
  });
});
