import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkingMemory } from "../src/memory/working.js";
import { EpisodicMemory } from "../src/memory/episodic.js";
import { SemanticMemory } from "../src/memory/semantic.js";
import { hybridRecall } from "../src/memory/hybrid_recall.js";
import { consolidateSession } from "../src/memory/consolidator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INIT_SQL = readFileSync(resolve(__dirname, "../src/db/migrations/0001_init.sql"), "utf-8");

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(INIT_SQL);
  return db;
}

describe("WorkingMemory", () => {
  let wm: WorkingMemory;
  beforeEach(() => { wm = new WorkingMemory(); });

  it("add and getAll", () => {
    wm.add({ role: "user", content: "hello" });
    wm.add({ role: "assistant", content: "hi" });
    expect(wm.getAll()).toHaveLength(2);
  });

  it("getRecent", () => {
    wm.add({ role: "user", content: "a" });
    wm.add({ role: "user", content: "b" });
    wm.add({ role: "user", content: "c" });
    expect(wm.getRecent(2).map((m) => m.content)).toEqual(["b", "c"]);
  });

  it("clear", () => {
    wm.add({ role: "user", content: "x" });
    wm.clear();
    expect(wm.getAll()).toHaveLength(0);
  });

  it("truncate keeps system + recent, drops middle", () => {
    wm.add({ role: "system", content: "sys" });
    wm.add({ role: "user", content: "a".repeat(100) });
    wm.add({ role: "user", content: "b".repeat(100) });
    wm.add({ role: "user", content: "c".repeat(20) });
    // system=3 tokens, a=25, b=25, c=5 => total 58
    // truncate to 15 tokens => system(1) + c(5) fits, a+b dropped
    wm.truncate(15);
    const msgs = wm.getAll();
    expect(msgs[0]!.content).toBe("sys");
    expect(msgs[1]!.content).toContain("earlier messages omitted");
    expect(msgs[msgs.length - 1]!.content).toBe("c".repeat(20));
  });
});

describe("EpisodicMemory", () => {
  let db: Database.Database;
  let em: EpisodicMemory;

  beforeEach(() => {
    db = createTestDb();
    // Insert a session for FK
    db.prepare("INSERT INTO sessions (id) VALUES (?)").run("sess1");
    em = new EpisodicMemory(db);
  });
  afterEach(() => db.close());

  it("store and recallBySession", () => {
    em.store("sess1", "user", "hello world");
    em.store("sess1", "assistant", "hi there");
    const results = em.recallBySession("sess1");
    expect(results).toHaveLength(2);
    expect(results[0]!.content).toBe("hello world");
  });

  it("FTS recall", () => {
    em.store("sess1", "user", "the quick brown fox");
    em.store("sess1", "user", "lazy dog sleeps");
    const results = em.recall("fox");
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain("fox");
  });
});

describe("SemanticMemory", () => {
  let db: Database.Database;
  let sm: SemanticMemory;

  beforeEach(() => {
    db = createTestDb();
    sm = new SemanticMemory(db);
  });
  afterEach(() => db.close());

  it("store and recall with cosine similarity", () => {
    const e1 = new Float32Array([1, 0, 0]);
    const e2 = new Float32Array([0, 1, 0]);
    const e3 = new Float32Array([0.9, 0.1, 0]);

    sm.store("about cats", e1);
    sm.store("about dogs", e2);
    sm.store("about kittens", e3);

    const query = new Float32Array([1, 0, 0]);
    const results = sm.recall(query, 2);
    expect(results).toHaveLength(2);
    expect(results[0]!.content).toBe("about cats");
    expect(results[0]!.score).toBeCloseTo(1.0);
    expect(results[1]!.content).toBe("about kittens");
  });

  it("pin and forget", () => {
    const e = new Float32Array([1, 0, 0]);
    const id = sm.store("pinnable", e);
    sm.pin(id);
    const row = db.prepare("SELECT pinned FROM semantic WHERE id = ?").get(id) as any;
    expect(row.pinned).toBe(1);
    sm.forget(id);
    const gone = db.prepare("SELECT * FROM semantic WHERE id = ?").get(id);
    expect(gone).toBeUndefined();
  });
});

describe("hybridRecall", () => {
  let db: Database.Database;
  let em: EpisodicMemory;
  let sm: SemanticMemory;

  beforeEach(() => {
    db = createTestDb();
    db.prepare("INSERT INTO sessions (id) VALUES (?)").run("sess1");
    em = new EpisodicMemory(db);
    sm = new SemanticMemory(db);
  });
  afterEach(() => db.close());

  it("returns fused results from episodic and semantic", () => {
    em.store("sess1", "user", "machine learning basics");
    const emb = new Float32Array([1, 0, 0]);
    sm.store("deep learning intro", emb);

    const results = hybridRecall("machine learning", {
      episodic: em,
      semantic: sm,
      embedding: new Float32Array([1, 0, 0]),
    });

    expect(results.length).toBeGreaterThan(0);
    const sources = results.map((r) => r.source);
    expect(sources).toContain("episodic");
    expect(sources).toContain("semantic");
  });
});

describe("consolidateSession", () => {
  let db: Database.Database;
  let em: EpisodicMemory;
  let sm: SemanticMemory;

  beforeEach(() => {
    db = createTestDb();
    db.prepare("INSERT INTO sessions (id) VALUES (?)").run("sess1");
    em = new EpisodicMemory(db);
    sm = new SemanticMemory(db);
  });
  afterEach(() => db.close());

  it("stores summary and facts from LLM response", async () => {
    em.store("sess1", "user", "How do I train a model?");
    em.store("sess1", "assistant", "Use pytorch with a dataloader.");

    const mockLlm = {
      async chat() {
        return JSON.stringify({
          summary: "User asked about model training.",
          atomic_facts: ["User wants to train ML models", "PyTorch was recommended"],
          profile_diff: null,
        });
      },
    };

    await consolidateSession("sess1", {
      llmAdapter: mockLlm,
      episodic: em,
      semantic: sm,
      config: { embeddingDim: 3 },
    });

    const rows = db.prepare("SELECT * FROM semantic").all() as any[];
    expect(rows).toHaveLength(3); // 1 summary + 2 facts
    expect(rows[0].content).toBe("User asked about model training.");
  });
});
