import type Database from "better-sqlite3";
import { ulid } from "ulid";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ApprovalQueue {
  private pending = new Map<string, PendingApproval>();
  private insertStmt;
  private resolveStmt;

  constructor(private db: Database.Database, private timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.insertStmt = db.prepare(
      `INSERT INTO approvals (id, tool_name, args, session_id, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', datetime('now'))`
    );
    this.resolveStmt = db.prepare(
      `UPDATE approvals SET status = ?, decision = ?, resolved_at = datetime('now') WHERE id = ?`
    );
  }

  enqueue(toolName: string, args: Record<string, unknown>, sessionId: string): Promise<boolean> {
    const id = ulid();
    this.insertStmt.run(id, toolName, JSON.stringify(args), sessionId);

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.resolve(id, false);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
    });
  }

  resolve(id: string, approved: boolean): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    const status = approved ? "approved" : "denied";
    this.resolveStmt.run(status, status, id);
    entry.resolve(approved);
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
