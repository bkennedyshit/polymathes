import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../src/db/open.js";
import { runMigrations } from "../src/db/migrate.js";
import Database from "better-sqlite3";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DB = join(tmpdir(), `polymath-test-${Date.now()}.db`);

describe("db", () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  it("openDb sets WAL mode and foreign keys", () => {
    db = openDb(TEST_DB);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("runMigrations creates all tables", () => {
    db = openDb(TEST_DB);
    runMigrations(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r: any) => r.name);
    expect(tables).toContain("sessions");
    expect(tables).toContain("episodic");
    expect(tables).toContain("semantic");
    expect(tables).toContain("cron_jobs");
    expect(tables).toContain("pairings");
    expect(tables).toContain("approvals");
    expect(tables).toContain("audit");
    expect(tables).toContain("schema_version");
  });

  it("runMigrations is idempotent", () => {
    db = openDb(TEST_DB);
    runMigrations(db);
    const before = db.prepare("SELECT version FROM schema_version").all().length;
    runMigrations(db); // should not throw, should not add duplicates
    const after = db.prepare("SELECT version FROM schema_version").all().length;
    expect(after).toBe(before);
    expect(after).toBeGreaterThanOrEqual(1);
  });

  it("audit table prevents UPDATE and DELETE", () => {
    db = openDb(TEST_DB);
    runMigrations(db);
    db.prepare("INSERT INTO audit (id, ts, tool_name, outcome) VALUES ('x', '2024-01-01', 'test', 'allow')").run();
    expect(() => db.prepare("UPDATE audit SET outcome='deny' WHERE id='x'").run()).toThrow();
    expect(() => db.prepare("DELETE FROM audit WHERE id='x'").run()).toThrow();
  });

  it("episodic FTS trigger works", () => {
    db = openDb(TEST_DB);
    runMigrations(db);
    db.prepare("INSERT INTO sessions (id) VALUES ('s1')").run();
    db.prepare("INSERT INTO episodic (id, session_id, content) VALUES ('e1', 's1', 'hello world test')").run();
    const results = db.prepare("SELECT * FROM episodic_fts WHERE episodic_fts MATCH 'hello'").all();
    expect(results.length).toBe(1);
  });
});
