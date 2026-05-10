import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../src/db/open.js";
import { runMigrations } from "../src/db/migrate.js";
import { ApprovalQueue } from "../src/security/approval.js";
import Database from "better-sqlite3";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DB = join(tmpdir(), `polymath-approval-test-${Date.now()}.db`);

describe("ApprovalQueue", () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  it("enqueue creates pending record and resolve approves", async () => {
    db = openDb(TEST_DB);
    runMigrations(db);
    const queue = new ApprovalQueue(db);
    const promise = queue.enqueue("shell.exec", { cmd: "ls" }, "s1");
    expect(queue.pendingCount).toBe(1);

    const row = db.prepare("SELECT * FROM approvals").get() as any;
    queue.resolve(row.id, true);

    const result = await promise;
    expect(result).toBe(true);
    expect(queue.pendingCount).toBe(0);
  });

  it("timeout auto-denies", async () => {
    db = openDb(TEST_DB);
    runMigrations(db);
    const queue = new ApprovalQueue(db, 50); // 50ms timeout
    const result = await queue.enqueue("shell.exec", {}, "s1");
    expect(result).toBe(false);
  });

  it("resolve with false denies", async () => {
    db = openDb(TEST_DB);
    runMigrations(db);
    const queue = new ApprovalQueue(db);
    const promise = queue.enqueue("test", {}, "s1");
    const row = db.prepare("SELECT id FROM approvals").get() as any;
    queue.resolve(row.id, false);
    expect(await promise).toBe(false);
  });
});
