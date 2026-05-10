CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  channel TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS episodic (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  role TEXT,
  content TEXT,
  tool_name TEXT,
  tool_args TEXT,
  tool_result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS semantic (
  id TEXT PRIMARY KEY,
  content TEXT,
  embedding BLOB,
  source_session TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  pinned INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cron_jobs (
  id TEXT PRIMARY KEY,
  cron_expr TEXT NOT NULL,
  agent_id TEXT,
  task TEXT,
  channel TEXT,
  enabled INTEGER DEFAULT 1,
  last_run TEXT,
  next_run TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pairings (
  id TEXT PRIMARY KEY,
  channel TEXT,
  sender_id TEXT,
  code TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  tool_name TEXT,
  args TEXT,
  session_id TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  decision TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  session_id TEXT,
  tool_name TEXT,
  args TEXT,
  outcome TEXT,
  duration_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS episodic_fts USING fts5(
  content,
  content=episodic,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS episodic_ai AFTER INSERT ON episodic BEGIN
  INSERT INTO episodic_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN
  SELECT RAISE(ABORT, 'audit records are immutable');
END;

CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN
  SELECT RAISE(ABORT, 'audit records are immutable');
END;
