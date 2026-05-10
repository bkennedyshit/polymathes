import type Database from "better-sqlite3";
import { ulid } from "ulid";

export interface AuditEntry {
  session_id?: string;
  tool_name: string;
  args?: Record<string, unknown>;
  outcome: "allow" | "deny" | "error" | "timeout";
  duration_ms?: number;
  error?: string;
}

export class AuditWriter {
  private stmt: Database.Statement | null = null;

  constructor(private db: Database.Database) {
    try {
      this.stmt = db.prepare(
        `INSERT INTO audit (id, ts, session_id, tool_name, args, outcome, duration_ms, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
    } catch {
      // table may not exist yet
    }
  }

  record(entry: AuditEntry): void {
    try {
      if (!this.stmt) {
        this.stmt = this.db.prepare(
          `INSERT INTO audit (id, ts, session_id, tool_name, args, outcome, duration_ms, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
      }
      this.stmt.run(
        ulid(),
        new Date().toISOString(),
        entry.session_id ?? null,
        entry.tool_name,
        entry.args ? JSON.stringify(entry.args) : null,
        entry.outcome,
        entry.duration_ms ?? null,
        entry.error ?? null
      );
    } catch (e) {
      console.error("[audit] write failed:", e);
    }
  }
}
