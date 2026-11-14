import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function database(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of readdirSync(new URL('../migrations/', import.meta.url)).filter(x => x.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  function prepared(sql: string, bindings: SQLInputValue[] = []): D1PreparedStatement {
    const meta = { duration: 0, size_after: 0, rows_read: 0, rows_written: 0, changed_db: false, changes: 0, last_row_id: 0 };
    function raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
    function raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
    async function raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
      const statement = sqlite.prepare(sql), rows = statement.all(...bindings).map(row => Object.values(row)) as T[];
      return options?.columnNames ? [statement.columns().map(x => x.name), ...rows] : rows;
    }
    return {
      bind(...values: SQLInputValue[]) { return prepared(sql, values); },
      async first(column?: string) { const row = sqlite.prepare(sql).get(...bindings); return column ? row?.[column] ?? null : row ?? null; },
      async run() { const result = sqlite.prepare(sql).run(...bindings); return { success: true, results: [], meta: { ...meta, changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
      async all() { return { success: true, results: sqlite.prepare(sql).all(...bindings), meta }; },
      raw
    } as D1PreparedStatement;
  }
  const db = { prepare: prepared, async batch(statements: D1PreparedStatement[]) { sqlite.exec('BEGIN'); try { const results = await Promise.all(statements.map(x => x.run())); sqlite.exec('COMMIT'); return results; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } } } as D1Database;
  return { db, sqlite };
}
