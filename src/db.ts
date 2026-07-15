import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  working_path TEXT,
  branch TEXT NOT NULL,
  task_summary TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'active', 'blocked', 'completed')),
  owner_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scope_claims (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  pattern TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  files_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  decision TEXT NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  alternatives_json TEXT NOT NULL DEFAULT '[]',
  scope_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'rejected')),
  supersedes_id TEXT REFERENCES decisions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  git_head TEXT,
  git_branch TEXT NOT NULL,
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'decision', 'handoff')),
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(kind, source_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_documents_fts USING fts5(
  title,
  body,
  content='search_documents',
  content_rowid='rowid',
  tokenize='unicode61 tokenchars ''_./:-'''
);

CREATE TRIGGER IF NOT EXISTS search_documents_ai AFTER INSERT ON search_documents BEGIN
  INSERT INTO search_documents_fts(rowid, title, body)
  VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS search_documents_ad AFTER DELETE ON search_documents BEGIN
  INSERT INTO search_documents_fts(search_documents_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS search_documents_au AFTER UPDATE ON search_documents BEGIN
  INSERT INTO search_documents_fts(search_documents_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO search_documents_fts(rowid, title, body)
  VALUES (new.rowid, new.title, new.body);
END;

CREATE INDEX IF NOT EXISTS idx_sessions_project_status ON sessions(project_id, status, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_scopes_project_expiry ON scope_claims(project_id, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_events_project_created ON events(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_decisions_project_status ON decisions(project_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_project_created ON handoffs(project_id, created_at);
`;

export interface DatabaseHandle {
  db: Database.Database;
  dataDir: string;
  dbPath: string;
}

export function openDatabase(rootPath: string): DatabaseHandle {
  const legacyDataDir = path.join(rootPath, ".devrelay");
  const dataDir = path.join(rootPath, ".agentrelay");
  if (!fs.existsSync(dataDir) && fs.existsSync(legacyDataDir)) {
    fs.renameSync(legacyDataDir, dataDir);
  }
  fs.mkdirSync(path.join(dataDir, "handoffs"), { recursive: true, mode: 0o700 });
  const legacyDbPath = path.join(dataDir, "devrelay.db");
  const dbPath = path.join(dataDir, "agentrelay.db");
  if (!fs.existsSync(dbPath) && fs.existsSync(legacyDbPath)) {
    fs.renameSync(legacyDbPath, dbPath);
    for (const suffix of ["-wal", "-shm"]) {
      const legacySidecar = `${legacyDbPath}${suffix}`;
      if (fs.existsSync(legacySidecar)) {
        fs.renameSync(legacySidecar, `${dbPath}${suffix}`);
      }
    }
  }
  const db = new Database(dbPath);
  fs.chmodSync(dbPath, 0o600);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  const sessionColumns = db.pragma("table_info(sessions)") as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === "working_path")) {
    db.exec("ALTER TABLE sessions ADD COLUMN working_path TEXT");
  }
  db.exec(`
    UPDATE sessions
    SET working_path = (SELECT root_path FROM projects WHERE projects.id = sessions.project_id)
    WHERE working_path IS NULL
  `);
  return { db, dataDir, dbPath };
}
