import { describe, it, expect, afterEach, vi } from "vitest";
import { openDb } from "../src/db/open.js";
import { runMigrations } from "../src/db/migrate.js";
import { CronScheduler } from "../src/cron/scheduler.js";
import Database from "better-sqlite3";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DB = join(tmpdir(), `polymath-cron-${Date.now()}.db`);

describe("CronScheduler", () => {
  let db: Database.Database;
  let scheduler: CronScheduler;

  afterEach(() => {
    if (scheduler) scheduler.stop();
    if (db) db.close();
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  function setup(onFire = vi.fn()) {
    db = openDb(TEST_DB);
    runMigrations(db);
    scheduler = new CronScheduler({ db, onFire, logger: { warn: () => {}, info: () => {} } });
    return onFire;
  }

  it("addJob stores in DB", () => {
    setup();
    const job = scheduler.addJob({ cron_expr: "0 0 * * *", task: "hello" });
    const rows = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").all(job.id);
    expect(rows).toHaveLength(1);
  });

  it("listJobs returns stored jobs", () => {
    setup();
    scheduler.addJob({ cron_expr: "0 0 * * *", task: "a" });
    scheduler.addJob({ cron_expr: "0 0 * * *", task: "b" });
    expect(scheduler.listJobs()).toHaveLength(2);
  });

  it("removeJob deletes from DB", () => {
    setup();
    const job = scheduler.addJob({ cron_expr: "0 0 * * *", task: "x" });
    scheduler.removeJob(job.id);
    expect(scheduler.listJobs()).toHaveLength(0);
  });

  it("invalid cron expression does not crash", () => {
    setup();
    expect(() => scheduler.addJob({ cron_expr: "not valid", task: "y" })).not.toThrow();
  });

  it("fire callback is called", async () => {
    const onFire = setup();
    scheduler.addJob({ cron_expr: "* * * * * *", task: "tick" });
    await new Promise((r) => setTimeout(r, 1200));
    expect(onFire).toHaveBeenCalled();
    expect(onFire.mock.calls[0][0].task).toBe("tick");
  });
});
