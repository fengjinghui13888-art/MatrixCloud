import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSqlite, runSqliteJson } from '../sqlite-client';

describe('portable sqlite client', () => {
  it('executes schema, parameters are not required, and returns JSON rows without sqlite3.exe', () => {
    const root = mkdtempSync(join(tmpdir(), 'matrix-sqlite-'));
    const file = join(root, 'state.sqlite');
    runSqlite(file, 'CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items(name) VALUES (\'中文\');');

    const rows = runSqliteJson(file, 'SELECT id, name FROM items ORDER BY id;');

    expect(JSON.parse(rows)).toEqual([{ id: 1, name: '中文' }]);
    expect(readFileSync(file)).toBeTruthy();
  });

  it('supports the Node 22 DatabaseSync API when statements do not expose columns()', () => {
    const root = mkdtempSync(join(tmpdir(), 'matrix-sqlite-node22-'));
    const file = join(root, 'state.sqlite');
    runSqlite(file, 'CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items(value) VALUES (\'a\'); UPDATE items SET value=\'b\' WHERE id=1;');
    expect(JSON.parse(runSqliteJson(file, 'SELECT value FROM items'))).toEqual([{ value: 'b' }]);
  });
});
