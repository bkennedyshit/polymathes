import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../src/db/open.js";
import { runMigrations } from "../src/db/migrate.js";
import { PairingManager } from "../src/security/pairing.js";
import { evaluateDmPolicy, type DmPolicy } from "../src/security/dm_policy.js";
import Database from "better-sqlite3";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DB = join(tmpdir(), `polymath-pairing-test-${Date.now()}.db`);

describe("PairingManager", () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  it("createPairing stores in DB", () => {
    db = openDb(TEST_DB);
    runMigrations(db);
    const mgr = new PairingManager(db);
    const code = mgr.createPairing("telegram", "user123");
    expect(code).toHaveLength(6);
    const row = db.prepare("SELECT * FROM pairings WHERE code = ?").get(code) as any;
    expect(row.channel).toBe("telegram");
    expect(row.sender_id).toBe("user123");
    expect(row.status).toBe("pending");
  });

  it("approvePairing updates status", () => {
    db = openDb(TEST_DB);
    runMigrations(db);
    const mgr = new PairingManager(db);
    const code = mgr.createPairing("telegram", "user1");
    mgr.approvePairing(code);
    const row = db.prepare("SELECT * FROM pairings WHERE code = ?").get(code) as any;
    expect(row.status).toBe("approved");
    expect(row.approved_at).not.toBeNull();
  });

  it("checkSender returns correct status", () => {
    db = openDb(TEST_DB);
    runMigrations(db);
    const mgr = new PairingManager(db);
    expect(mgr.checkSender("telegram", "nobody")).toBe("unknown");
    mgr.createPairing("telegram", "user1");
    expect(mgr.checkSender("telegram", "user1")).toBe("pending");
    const code = db.prepare("SELECT code FROM pairings WHERE sender_id = 'user1'").get() as any;
    mgr.approvePairing(code.code);
    expect(mgr.checkSender("telegram", "user1")).toBe("approved");
  });

  it("listPending returns pending pairings", () => {
    db = openDb(TEST_DB);
    runMigrations(db);
    const mgr = new PairingManager(db);
    mgr.createPairing("telegram", "a");
    mgr.createPairing("discord", "b");
    expect(mgr.listPending()).toHaveLength(2);
  });
});

describe("evaluateDmPolicy", () => {
  let db: Database.Database;

  afterEach(() => {
    if (db) db.close();
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + "-wal"); } catch {}
    try { unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  it("open mode always allows", async () => {
    db = openDb(TEST_DB);
    runMigrations(db);
    const mgr = new PairingManager(db);
    const policies: DmPolicy[] = [{ mode: "open", channel: "telegram" }];
    expect(await evaluateDmPolicy("telegram", "anyone", policies, mgr)).toBe("allow");
  });

  it("closed mode always denies", async () => {
    db = openDb(TEST_DB);
    runMigrations(db);
    const mgr = new PairingManager(db);
    const policies: DmPolicy[] = [{ mode: "closed", channel: "telegram" }];
    expect(await evaluateDmPolicy("telegram", "anyone", policies, mgr)).toBe("deny");
  });

  it("pairing mode creates pairing for unknown sender", async () => {
    db = openDb(TEST_DB);
    runMigrations(db);
    const mgr = new PairingManager(db);
    const policies: DmPolicy[] = [{ mode: "pairing", channel: "telegram" }];
    expect(await evaluateDmPolicy("telegram", "newuser", policies, mgr)).toBe("pair");
    expect(mgr.checkSender("telegram", "newuser")).toBe("pending");
  });

  it("pairing mode allows approved sender", async () => {
    db = openDb(TEST_DB);
    runMigrations(db);
    const mgr = new PairingManager(db);
    const code = mgr.createPairing("telegram", "user1");
    mgr.approvePairing(code);
    const policies: DmPolicy[] = [{ mode: "pairing", channel: "telegram" }];
    expect(await evaluateDmPolicy("telegram", "user1", policies, mgr)).toBe("allow");
  });

  it("no matching policy denies", async () => {
    db = openDb(TEST_DB);
    runMigrations(db);
    const mgr = new PairingManager(db);
    expect(await evaluateDmPolicy("unknown_channel", "user1", [], mgr)).toBe("deny");
  });
});
