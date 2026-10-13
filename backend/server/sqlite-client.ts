import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

export type SqliteOutput = 'text' | 'json';

function stripCliDirectives(query: string) {
  return query.replace(/^\s*(?:\.timeout\s+\d+|\.mode\s+\w+)\s*/gm, '').trim();
}

function splitStatements(query: string) {
  const statements: string[] = [];
  let start = 0;
  let quoted: string | null = null;
  for (let i = 0; i < query.length; i += 1) {
    const char = query[i];
    if (quoted) {
      if (char === quoted && query[i + 1] === quoted) { i += 1; continue; }
      if (char === quoted) quoted = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quoted = char; continue; }
    if (char === ';') {
      const statement = query.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  const tail = query.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

export function runSqlite(filePath: string, query: string, output: SqliteOutput = 'text'): string {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    const sql = stripCliDirectives(query);
    if (!sql) return '';
    const statements = splitStatements(sql);
    const rows: Array<Record<string, unknown>> = [];
    for (const statementSql of statements) {
      const statement = db.prepare(statementSql);
      // Node 22's experimental DatabaseSync API has no columns() method.
      // all() executes both row-returning and mutation statements; mutations
      // return an empty array, so this remains compatible with newer Node.
      rows.push(...statement.all() as Array<Record<string, unknown>>);
    }
    if (output === 'json') return JSON.stringify(rows);
    return rows.map(row => Object.values(row).map(value => value == null ? '' : String(value)).join('|')).join('\n');
  } finally {
    db.close();
  }
}

export function runSqliteJson(filePath: string, query: string) {
  return runSqlite(filePath, query, 'json');
}
