import type { SynapseDb } from '../types.js';

export const SYNAPSE_SCHEMA = `
CREATE TABLE IF NOT EXISTS synapse_operatives (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  skill_id           TEXT,
  specialist_id      TEXT,
  state              TEXT NOT NULL DEFAULT 'IDLE'
    CHECK(state IN ('IDLE','ACTIVE','CHECKOUT','STANDDOWN','SUSPENDED','DONE')),
  suspend_reason     TEXT
    CHECK(suspend_reason IN ('budget_exceeded','compaction','manual') OR suspend_reason IS NULL),
  health_state       TEXT NOT NULL DEFAULT 'IDLE'
    CHECK(health_state IN ('WORKING','STALLED','ZOMBIE','BLOCKED','IDLE')),
  mission_id         TEXT,
  strike_team_id     TEXT,
  budget_cap_usd     REAL NOT NULL DEFAULT 10.0,
  spent_usd          REAL NOT NULL DEFAULT 0.0,
  commendation_score REAL NOT NULL DEFAULT 0.0,
  sortie_interval_ms INTEGER NOT NULL DEFAULT 30000,
  last_sortie_at     TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS synapse_strike_teams (
  id            TEXT PRIMARY KEY,
  mandate_text  TEXT NOT NULL,
  operative_ids TEXT NOT NULL DEFAULT '[]',
  mission_ids   TEXT NOT NULL DEFAULT '[]',
  blueprint_id  TEXT,
  status        TEXT NOT NULL DEFAULT 'deploying'
    CHECK(status IN ('deploying','active','converging','done','standdown')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS synapse_missions (
  id                     TEXT PRIMARY KEY,
  parent_mission_id      TEXT,
  strike_team_id         TEXT,
  title                  TEXT NOT NULL,
  complexity             TEXT NOT NULL DEFAULT 'orchestrate'
    CHECK(complexity IN ('read','orchestrate','mutate')),
  status                 TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','active','done','blocked','failed')),
  assigned_operative_id  TEXT,
  requires_approval_gate INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS synapse_sorties (
  id              TEXT PRIMARY KEY,
  operative_id    TEXT NOT NULL,
  mission_id      TEXT,
  status          TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('running','completed','failed','interrupted_compaction','deferred')),
  tokens_used     INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0.0,
  field_report_id TEXT,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT
);

CREATE TABLE IF NOT EXISTS synapse_field_reports (
  id                       TEXT PRIMARY KEY,
  sortie_id                TEXT NOT NULL,
  operative_id             TEXT NOT NULL,
  strike_team_id           TEXT,
  mission_title            TEXT NOT NULL,
  findings                 TEXT NOT NULL DEFAULT '',
  files_changed            TEXT NOT NULL DEFAULT '[]',
  blockers_encountered     TEXT NOT NULL DEFAULT '',
  next_recommended_action  TEXT NOT NULL DEFAULT '',
  tokens_used              INTEGER NOT NULL DEFAULT 0,
  cost_usd                 REAL NOT NULL DEFAULT 0.0,
  ledger_path              TEXT,
  status                   TEXT NOT NULL DEFAULT 'completed'
    CHECK(status IN ('completed','blocked','failed')),
  completed_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS synapse_approvals (
  id            TEXT PRIMARY KEY,
  mission_id    TEXT,
  operative_id  TEXT NOT NULL,
  action        TEXT NOT NULL,
  description   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','rejected')),
  decided_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_syn_operatives_state  ON synapse_operatives(state);
CREATE INDEX IF NOT EXISTS idx_syn_operatives_team   ON synapse_operatives(strike_team_id);
CREATE INDEX IF NOT EXISTS idx_syn_sorties_op_status ON synapse_sorties(operative_id, status);
CREATE INDEX IF NOT EXISTS idx_syn_missions_team     ON synapse_missions(strike_team_id);
CREATE INDEX IF NOT EXISTS idx_syn_approvals_pending ON synapse_approvals(status);
`;

export function initSynapseSchema(db: SynapseDb): void {
  db.exec(SYNAPSE_SCHEMA);
}
