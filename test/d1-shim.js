// A tiny in-memory stand-in for Cloudflare D1, so the Worker's routes can be tested with plain `node --test`.
import { DatabaseSync } from 'node:sqlite';

export function createD1() {
  const db = new DatabaseSync(':memory:');
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    async first() {
      return db.prepare(sql).get(...args) ?? null;
    },
    async all() {
      return { results: db.prepare(sql).all(...args) };
    },
    async run() {
      const info = db.prepare(sql).run(...args);
      return { meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    },
    _exec() {
      const st = db.prepare(sql);
      if (/^\s*(SELECT|.*RETURNING)/is.test(sql)) return { results: st.all(...args) };
      const info = st.run(...args);
      return { results: [], meta: { changes: Number(info.changes) } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s._exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
