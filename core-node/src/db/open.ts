import Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const DEFAULT_PATH = join(homedir(), ".polymath", "state.db");

export function openDb(path: string = DEFAULT_PATH): Database.Database {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}
