import type { ArchitectsDb } from '../types.js';

export const ARCHITECTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS architects_blueprints (
  id             TEXT PRIMARY KEY,
  strike_team_id TEXT,
  title          TEXT NOT NULL,
  workflow_id    TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('draft','active','converging','done','archived')),
  variables      TEXT NOT NULL DEFAULT '{}',
  worklist_id    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS architects_worklists (
  id           TEXT PRIMARY KEY,
  blueprint_id TEXT NOT NULL,
  title        TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS architects_work_items (
  id                    TEXT PRIMARY KEY,
  worklist_id           TEXT NOT NULL,
  title                 TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'todo'
    CHECK(status IN ('todo','claimed','in_progress','done','failed','blocked')),
  depends_on            TEXT NOT NULL DEFAULT '[]',
  assigned_operative_id TEXT,
  construction_lock_id  TEXT,
  branch                TEXT,
  merged_at             TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS architects_construction_locks (
  id            TEXT PRIMARY KEY,
  work_item_id  TEXT NOT NULL,
  operative_id  TEXT NOT NULL,
  acquired_at   TEXT NOT NULL DEFAULT (datetime('now')),
  released_at   TEXT,
  hook_ref      TEXT
);

CREATE TABLE IF NOT EXISTS architects_relay_messages (
  id                TEXT PRIMARY KEY,
  from_operative_id TEXT NOT NULL,
  to_operative_id   TEXT,
  strike_team_id    TEXT,
  subject           TEXT NOT NULL,
  body              TEXT NOT NULL,
  sent_at           TEXT NOT NULL DEFAULT (datetime('now')),
  read_at           TEXT,
  priority          TEXT NOT NULL DEFAULT 'normal'
    CHECK(priority IN ('normal','urgent'))
);

CREATE TABLE IF NOT EXISTS architects_convergence_runs (
  id             TEXT PRIMARY KEY,
  worklist_id    TEXT NOT NULL,
  strategy       TEXT NOT NULL DEFAULT 'bisecting'
    CHECK(strategy IN ('sequential','bisecting')),
  work_item_ids  TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('running','merged','failed','bisecting','deferred')),
  failed_item_id TEXT,
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at   TEXT
);

CREATE TABLE IF NOT EXISTS architects_dispatch_queue (
  id             TEXT PRIMARY KEY,
  operative_id   TEXT NOT NULL,
  work_item_id   TEXT NOT NULL,
  scheduled_at   TEXT NOT NULL DEFAULT (datetime('now')),
  dispatched_at  TEXT,
  status         TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','dispatched','failed'))
);

CREATE INDEX IF NOT EXISTS idx_arch_items_worklist   ON architects_work_items(worklist_id, status);
CREATE INDEX IF NOT EXISTS idx_arch_items_operative  ON architects_work_items(assigned_operative_id);
CREATE INDEX IF NOT EXISTS idx_arch_locks_item       ON architects_construction_locks(work_item_id, released_at);
CREATE INDEX IF NOT EXISTS idx_arch_relay_to_op      ON architects_relay_messages(to_operative_id, read_at);
CREATE INDEX IF NOT EXISTS idx_arch_relay_to_team    ON architects_relay_messages(strike_team_id, read_at);
`;

export function initArchitectsSchema(db: ArchitectsDb): void {
  db.exec(ARCHITECTS_SCHEMA);
}
