import type Database from "better-sqlite3";

const INIT_SQL = `
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
`;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: INIT_SQL },
  { version: 2, sql: `
    -- v2: long-term memory polish + media memory foundation.
    -- Adds consolidation tracking on sessions and a structured media index
    -- so the agent can reason about the user's content catalog directly.

    ALTER TABLE sessions ADD COLUMN consolidated_at TEXT;

    -- Every media file the indexer has seen. One row per unique absolute path.
    -- This is EPISODIC memory for media: what exists, where, when, what brand.
    CREATE TABLE IF NOT EXISTS media_items (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      kind TEXT,                 -- 'video' | 'image' | 'audio'
      brand TEXT,                -- from path convention: input/<brand>/
      category TEXT,             -- 'raw' | 'edited' | 'reel' | 'photo' | 'archive'
      intent TEXT,               -- auto-classified: ride/trick/crash/chill/...
      duration_sec REAL,
      width INTEGER,
      height INTEGER,
      aspect_ratio REAL,
      file_size_bytes INTEGER,
      modified_at TEXT,          -- file system mtime
      indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata_json TEXT,        -- free-form extras: exif, ffprobe, caption, tags
      source_hash TEXT           -- perceptual hash for dedup
    );
    CREATE INDEX IF NOT EXISTS idx_media_items_brand ON media_items (brand);
    CREATE INDEX IF NOT EXISTS idx_media_items_category ON media_items (category);
    CREATE INDEX IF NOT EXISTS idx_media_items_modified ON media_items (modified_at DESC);

    -- Every transformation or publish event a media file has been through.
    -- Lets the agent answer: "has this session been reeled?" / "which drafts
    -- did I never finish?" / "what did this reel get cut from?"
    CREATE TABLE IF NOT EXISTS media_workflow (
      id TEXT PRIMARY KEY,
      source_id TEXT REFERENCES media_items(id),
      derived_id TEXT REFERENCES media_items(id),
      step TEXT NOT NULL,        -- 'analyze' | 'edit' | 'reel' | 'crop' | 'post' | 'repurpose'
      platform TEXT,             -- when step='post': 'instagram' | 'tiktok' | 'youtube' | ...
      tool TEXT,                 -- what actor did the step: 'session-highlight-editor' | 'resolve' | 'user'
      session_id TEXT,           -- which agent session was involved, if any
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      metrics_json TEXT          -- views/likes/etc when known
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_source ON media_workflow (source_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_derived ON media_workflow (derived_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_step ON media_workflow (step);

    -- FTS for media captions / tags / notes so natural-language media search
    -- works even without vision embeddings (e.g. "find the clip where I
    -- mentioned the pump track in my voiceover").
    CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(
      content,
      content='media_items',
      content_rowid='rowid'
    );
  ` },
  { version: 3, sql: `
    -- v3: mid-session consolidation support + media FTS triggers.
    -- compressed_at on episodic lets the scheduler mark old turns as
    -- summarized-into-semantic so they're filtered out of working memory
    -- without losing the audit trail (rows still exist).

    ALTER TABLE episodic ADD COLUMN compressed_at TEXT;

    -- Media FTS triggers — automatically index inserts/updates/deletes so
    -- natural-language queries against media_fts stay current without a
    -- manual reindex pass.
    CREATE TRIGGER IF NOT EXISTS media_items_ai
      AFTER INSERT ON media_items
      BEGIN
        INSERT INTO media_fts(rowid, content) VALUES (
          new.rowid,
          COALESCE(new.metadata_json, '') || ' ' ||
          COALESCE(new.brand, '') || ' ' ||
          COALESCE(new.category, '') || ' ' ||
          COALESCE(new.intent, '') || ' ' ||
          new.path
        );
      END;

    CREATE TRIGGER IF NOT EXISTS media_items_ad
      AFTER DELETE ON media_items
      BEGIN
        INSERT INTO media_fts(media_fts, rowid, content) VALUES ('delete', old.rowid, '');
      END;

    CREATE TRIGGER IF NOT EXISTS media_items_au
      AFTER UPDATE ON media_items
      BEGIN
        INSERT INTO media_fts(media_fts, rowid, content) VALUES ('delete', old.rowid, '');
        INSERT INTO media_fts(rowid, content) VALUES (
          new.rowid,
          COALESCE(new.metadata_json, '') || ' ' ||
          COALESCE(new.brand, '') || ' ' ||
          COALESCE(new.category, '') || ' ' ||
          COALESCE(new.intent, '') || ' ' ||
          new.path
        );
      END;

    -- Backfill: any rows added under v2 don't have FTS entries yet.
    INSERT INTO media_fts(rowid, content)
      SELECT rowid,
             COALESCE(metadata_json, '') || ' ' ||
             COALESCE(brand, '') || ' ' ||
             COALESCE(category, '') || ' ' ||
             COALESCE(intent, '') || ' ' ||
             path
      FROM media_items
      WHERE rowid NOT IN (SELECT rowid FROM media_fts);
  ` },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    db.prepare("SELECT version FROM schema_version").all().map((r: any) => r.version as number)
  );

  for (const { version, sql } of MIGRATIONS) {
    if (applied.has(version)) continue;
    db.exec(sql);
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
  }
}
