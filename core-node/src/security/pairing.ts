import type Database from "better-sqlite3";
import { ulid } from "ulid";

function randomCode(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export class PairingManager {
  constructor(private db: Database.Database) {}

  createPairing(channel: string, senderId: string): string {
    const code = randomCode();
    this.db.prepare(
      `INSERT INTO pairings (id, channel, sender_id, code, status, created_at) VALUES (?, ?, ?, ?, 'pending', datetime('now'))`,
    ).run(ulid(), channel, senderId, code);
    return code;
  }

  approvePairing(code: string): void {
    this.db.prepare(
      `UPDATE pairings SET status = 'approved', approved_at = datetime('now') WHERE code = ? AND status = 'pending'`,
    ).run(code);
  }

  /**
   * Pre-approve a sender without requiring a pairing code exchange.
   * Used at boot for channels.<transport>.allowed_users.
   * Creates a new approved row only when no prior approved row exists.
   */
  preApprove(channel: string, senderId: string): void {
    const existing = this.db.prepare(
      `SELECT status FROM pairings WHERE channel = ? AND sender_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(channel, senderId) as { status: string } | undefined;
    if (existing?.status === "approved") return;
    // If there's a pending row, flip it. Otherwise insert a fresh approved row.
    if (existing?.status === "pending") {
      this.db.prepare(
        `UPDATE pairings SET status = 'approved', approved_at = datetime('now') WHERE channel = ? AND sender_id = ? AND status = 'pending'`,
      ).run(channel, senderId);
    } else {
      this.db.prepare(
        `INSERT INTO pairings (id, channel, sender_id, code, status, approved_at, created_at) VALUES (?, ?, ?, 'preapproved', 'approved', datetime('now'), datetime('now'))`,
      ).run(ulid(), channel, senderId);
    }
  }

  denyPairing(code: string): void {
    this.db.prepare(`UPDATE pairings SET status = 'denied' WHERE code = ? AND status = 'pending'`).run(code);
  }

  checkSender(channel: string, senderId: string): "approved" | "pending" | "unknown" {
    const row = this.db.prepare(
      `SELECT status FROM pairings WHERE channel = ? AND sender_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(channel, senderId) as { status: string } | undefined;
    if (!row) return "unknown";
    if (row.status === "approved") return "approved";
    if (row.status === "pending") return "pending";
    return "unknown";
  }

  listPending(): Array<{ id: string; channel: string; sender_id: string; code: string; created_at: string }> {
    return this.db.prepare(`SELECT id, channel, sender_id, code, created_at FROM pairings WHERE status = 'pending'`).all() as any;
  }
}
