/**
 * The room's SQLite tables (spec 8.3) behind one wrapper that counts every row written, so
 * tests can prove that a live dictation writes at most one row (spec 15.1).
 */

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS room (
     owner_device_id TEXT NOT NULL,
     salt TEXT NOT NULL,
     created_at INTEGER NOT NULL)`,
  // WITHOUT ROWID: the primary key is the table itself, so an insert writes one row, not two.
  `CREATE TABLE IF NOT EXISTS devices (
     device_id TEXT PRIMARY KEY,
     signing_public_key TEXT NOT NULL,
     role TEXT NOT NULL,
     added_at INTEGER NOT NULL,
     last_seen_day INTEGER NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS admissions (
     admission_sha256 TEXT PRIMARY KEY,
     expires_at INTEGER NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS owner_events (
     id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL,
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS buffered (
     id INTEGER PRIMARY KEY,
     recipient_device_id TEXT NOT NULL,
     frames BLOB NOT NULL,
     expires_at INTEGER NOT NULL)`,
];

export type Row = Record<string, SqlStorageValue>;

export class RoomStore {
  /** Rows written by SQL statements since the object started (tests read this). */
  rowsWritten = 0;
  rowsRead = 0;
  /** setAlarm/deleteAlarm calls; Cloudflare bills each as a write. */
  alarmWrites = 0;

  constructor(private readonly sql: SqlStorage) {}

  get writes(): number {
    return this.rowsWritten + this.alarmWrites;
  }

  exec<T extends Row = Row>(query: string, ...bindings: unknown[]): T[] {
    const cursor = this.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    this.rowsWritten += cursor.rowsWritten;
    this.rowsRead += cursor.rowsRead;
    return rows;
  }

  one<T extends Row = Row>(query: string, ...bindings: unknown[]): T | undefined {
    return this.exec<T>(query, ...bindings)[0];
  }

  /** True once `create` has succeeded. Reads sqlite_master only; writes nothing. */
  roomExists(): boolean {
    const t = this.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room'");
    if (!t) return false;
    return this.one("SELECT owner_device_id FROM room LIMIT 1") !== undefined;
  }

  createSchema(): void {
    for (const s of SCHEMA) this.exec(s);
  }
}
