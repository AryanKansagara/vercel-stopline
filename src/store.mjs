/** Durable private metadata only. Credentials, prompts and response bodies never enter this module. */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, lstatSync, chmodSync, accessSync, constants } from 'node:fs';
import { resolve, join, parse } from 'node:path';
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
const DAYS = 30 * 86400000;
export function secureDirectory(path) {
  const absolute = resolve(path); let cursor = parse(absolute).root;
  for (const piece of absolute.slice(cursor.length).split('/').filter(Boolean)) {
    cursor = join(cursor, piece);
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error('DATA_DIR must not contain symlinks'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; mkdirSync(cursor, { mode: 0o700 }); }
  }
  if (!lstatSync(absolute).isDirectory()) throw new Error('DATA_DIR must be a directory');
  accessSync(absolute, constants.R_OK | constants.W_OK | constants.X_OK); chmodSync(absolute, 0o700);
  return absolute;
}
export class RunStore {
  constructor(directory) {
    this.directory = secureDirectory(directory); const file = join(this.directory, 'stopline.sqlite');
    try { if (lstatSync(file).isSymbolicLink()) throw new Error('Database symlinks are refused'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.db = new DatabaseSync(file); chmodSync(file, 0o600);
    this.db.exec('PRAGMA page_size=4096; PRAGMA max_page_count=32768; PRAGMA journal_size_limit=8388608; PRAGMA wal_autocheckpoint=128; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000; PRAGMA secure_delete=ON;');
    if (this.db.prepare('PRAGMA max_page_count').get().max_page_count > 32768) { this.db.close(); this.db = null; throw new Error('Existing database exceeds configured page ceiling'); }
    this.db.exec(`CREATE TABLE IF NOT EXISTS workspaces (owner TEXT PRIMARY KEY, created INTEGER NOT NULL, seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES workspaces(owner) ON DELETE CASCADE, created INTEGER NOT NULL, status TEXT NOT NULL, report TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS owner_runs ON runs(owner,created);`);
    this.prune();
    for (const row of this.db.prepare("SELECT id,owner,report FROM runs WHERE status IN ('queued','running','settling')").all()) {
      const r = JSON.parse(row.report); r.status = 'interrupted'; r.terminal = true; r.stopReason = 'process_restart'; r.error = 'Run interrupted by a process restart'; r.cleanup = { activeRequest: false, activeTimers: 0 }; r.completedAt = new Date().toISOString();
      this.save(row.owner, r);
    }
  }
  prune() {
    this.db.prepare('DELETE FROM workspaces WHERE seen < ?').run(Date.now() - DAYS);
    this.db.prepare('DELETE FROM runs WHERE created < ?').run(Date.now() - DAYS);
  }
  createWorkspace() {
    this.prune(); if (this.db.prepare('SELECT count(*) AS n FROM workspaces').get().n >= 1000) throw new Error('Workspace capacity reached');
    const token = randomBytes(32).toString('hex'), now = Date.now();
    this.db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run(tokenHash(token), now, now);
    return { token, workspace: { createdAt: new Date(now).toISOString() } };
  }
  authenticate(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    const hash = tokenHash(token), row = this.db.prepare('SELECT created FROM workspaces WHERE owner=?').get(hash);
    if (!row) return null; this.db.prepare('UPDATE workspaces SET seen=? WHERE owner=?').run(Date.now(), hash); return hash;
  }
  save(owner, report) {
    this.db.prepare('INSERT INTO runs(id,owner,created,status,report) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,report=excluded.report WHERE runs.owner=excluded.owner')
      .run(report.id, owner, Date.parse(report.createdAt), report.status, JSON.stringify(report));
  }
  makeRoom(owner) {
    this.prune();
    const own = this.db.prepare('SELECT id,status FROM runs WHERE owner=? ORDER BY created ASC').all(owner);
    let count = own.length;
    for (const row of own) {
      if (count < 100) break;
      if (['queued','running','settling'].includes(row.status)) continue;
      this.db.prepare('DELETE FROM runs WHERE owner=? AND id=?').run(owner, row.id); count--;
    }
    if (count >= 100) throw new Error('Workspace saved run capacity reached');
    if (this.db.prepare('SELECT count(*) AS n FROM runs').get().n >= 10000) throw new Error('Saved run capacity reached');
  }
  get(owner, id) { const row = this.db.prepare('SELECT report FROM runs WHERE owner=? AND id=?').get(owner, id); return row ? JSON.parse(row.report) : null; }
  list(owner) { return this.db.prepare('SELECT report FROM runs WHERE owner=? ORDER BY created DESC LIMIT 100').all(owner).map(r => { const { events, ...report } = JSON.parse(r.report); return report; }); }
  deleteRun(owner, id) { return Number(this.db.prepare('DELETE FROM runs WHERE owner=? AND id=?').run(owner, id).changes) > 0; }
  deleteWorkspace(owner) { this.db.prepare('DELETE FROM workspaces WHERE owner=?').run(owner); }
  close() { if (!this.db) return; this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close(); this.db = null; }
}
