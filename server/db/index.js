import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../util/common.js';

const MIG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export function openDb(file) {
  // Un volume existant garde ses anciens droits : on les resserre à chaque ouverture.
  if (file !== ':memory:') { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(file), 0o700); }
  const db = new DatabaseSync(file);
  // Comptes, jetons hachés, secrets scellés : lisibles par le Hub seul (les fichiers -wal et -shm prennent les mêmes droits).
  if (file !== ':memory:') fs.chmodSync(file, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;');
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied INTEGER NOT NULL)');
  const done = new Set(db.prepare('SELECT name FROM _migrations').all().map(r => r.name));
  for (const f of fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    db.exec('BEGIN');
    try {
      db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
      db.prepare('INSERT INTO _migrations VALUES (?, ?)').run(f, Date.now());
      db.exec('COMMIT');
      log.info('migration appliquée', f);
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  // petites aides
  db.get = (sql, ...p) => db.prepare(sql).get(...p);
  db.all = (sql, ...p) => db.prepare(sql).all(...p);
  db.run = (sql, ...p) => db.prepare(sql).run(...p);
  db.tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  db.setting = (k, d = null) => { const r = db.get('SELECT value FROM settings WHERE key=?', k); return r ? JSON.parse(r.value) : d; };
  db.setSetting = (k, v) => db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, JSON.stringify(v));
  return db;
}
