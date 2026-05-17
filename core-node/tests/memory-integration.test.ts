import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../src/db/migrate.js";
import { EpisodicMemory } from "../src/memory/episodic.js";
import { SemanticMemory } from "../src/memory/semantic.js";
import { consolidateSession } from "../src/memory/consolidator.js";
import { hybridRecall } from "../src/memory/hybrid_recall.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("Memory integration", () => {
  let db: Database.Database;
  let episodic: EpisodicMemory;
  let semantic: SemanticMemory;

  beforeEach(() => {
    db = createTestDb();
    db.prepare("INSERT INTO sessions (id) VALUES (?)").run("int-sess");
    episodic = new EpisodicMemory(db);
    semantic = new SemanticMemory(db);
  });
  afterEach(() => db.close());

  it("full flow: store → consolidate → recall", async () => {
    // Store episodic entries
    episodic.store("int-sess", "user", "How do I deploy to AWS?");
    episodic.store("int-sess", "assistant", "Use CDK or Terraform for infrastructure as code.");
    episodic.store("int-sess", "user", "What about serverless?");
    episodic.store("int-sess", "assistant", "Lambda with API Gateway is the standard pattern.");

    // Consolidate with mock LLM
    const mockLlm = {
      async chat() {
        return JSON.stringify({
          summary: "User asked about AWS deployment strategies.",
          atomic_facts: [
            "CDK and Terraform recommended for IaC",
            "Lambda + API Gateway for serverless",
          ],
          profile_diff: null,
        });
      },
    };

    // Stub embedder so we don't need Ollama running.
    const stubEmbedder = {
      name: "stub",
      dim: 3,
      async embed() { return new Float32Array([1, 0, 0]); },
      async embedBatch(texts: string[]) {
        return texts.map(() => new Float32Array([1, 0, 0]));
      },
    };

    await consolidateSession("int-sess", {
      llmAdapter: mockLlm,
      episodic,
      semantic,
      embedder: stubEmbedder,
    });

    // Verify semantic entries exist
    const rows = db.prepare("SELECT * FROM semantic").all() as any[];
    expect(rows).toHaveLength(3); // 1 summary + 2 facts
    expect(rows[0].content).toBe("User asked about AWS deployment strategies.");

    // Verify hybrid recall returns results
    const results = hybridRecall("AWS deploy", {
      episodic,
      semantic,
      embedding: new Float32Array([1, 0, 0]),
    });
    expect(results.length).toBeGreaterThan(0);
    const contents = results.map((r) => r.content);
    expect(contents.some((c) => c.includes("AWS") || c.includes("deploy"))).toBe(true);
  });
});
