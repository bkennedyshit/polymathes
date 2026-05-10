import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../src/db/open.js";
import { runMigrations } from "../src/db/migrate.js";
import { AuditWriter } from "../src/audit/writer.js";
import Database from "better-sqlite3";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DB = join(tmpdir(), `polymath-audit-test-${Date.now()}.db`);

describe("AuditWriter", () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  it("records an audit entry", () => {
    db = openDb(TEST_DB);
    runMigrations(db);
    const writer = new AuditWriter(db);
    writer.record({ tool_name: "fs.read", outcome: "allow", session_id: "s1", duration_ms: 42 });
    const rows = db.prepare("SELECT * FROM audit").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe("fs.read");
    expect(rows[0].outcome).toBe("allow");
    expect(rows[0].duration_ms).toBe(42);
  });

  it("never throws on error", () => {
    db = openDb(TEST_DB);
    // Don't run migrations — table doesn't exist
    const writer = new AuditWriter(db);
    expect(() => writer.record({ tool_name: "x", outcome: "allow" })).not.toThrow();
  });

  it("stores args as JSON", () => {
    db = openDb(TEST_DB);
    runMigrations(db);
    const writer = new AuditWriter(db);
    writer.record({ tool_name: "test", outcome: "deny", args: { path: "/tmp" } });
    const row = db.prepare("SELECT args FROM audit").get() as any;
    expect(JSON.parse(row.args)).toEqual({ path: "/tmp" });
  });
});
