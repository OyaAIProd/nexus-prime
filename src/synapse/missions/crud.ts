import { randomUUID } from 'crypto';
import type { Mission, StrikeTeam, SynapseDb } from '../types.js';

function parseArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function mapMission(row: any): Mission {
  return {
    id: row.id,
    parentMissionId: row.parent_mission_id ?? null,
    strikeTeamId: row.strike_team_id ?? null,
    title: row.title,
    complexity: row.complexity,
    status: row.status,
    assignedOperativeId: row.assigned_operative_id ?? null,
    requiresApprovalGate: Boolean(row.requires_approval_gate),
    createdAt: row.created_at,
  };
}

function mapStrikeTeam(row: any): StrikeTeam {
  return {
    id: row.id,
    mandateText: row.mandate_text,
    operativeIds: parseArray(row.operative_ids),
    missionIds: parseArray(row.mission_ids),
    blueprintId: row.blueprint_id ?? null,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function insertMission(db: SynapseDb, input: Partial<Mission> & { title: string; id?: string }): Mission {
  const id = input.id ?? randomUUID();
  db.prepare(`
    INSERT INTO synapse_missions (
      id, parent_mission_id, strike_team_id, title, complexity, status,
      assigned_operative_id, requires_approval_gate, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `).run(
    id,
    input.parentMissionId ?? null,
    input.strikeTeamId ?? null,
    input.title,
    input.complexity ?? 'orchestrate',
    input.status ?? 'open',
    input.assignedOperativeId ?? null,
    input.requiresApprovalGate ? 1 : 0,
    input.createdAt ?? null,
  );
  return getMission(db, id)!;
}

export function getMission(db: SynapseDb, missionId: string | null | undefined): Mission | null {
  if (!missionId) return null;
  const row = db.prepare('SELECT * FROM synapse_missions WHERE id=?').get(missionId);
  return row ? mapMission(row) : null;
}

export function getMissionsForStrikeTeam(db: SynapseDb, strikeTeamId: string): Mission[] {
  return (db.prepare('SELECT * FROM synapse_missions WHERE strike_team_id=? ORDER BY created_at ASC').all(strikeTeamId) as any[]).map(mapMission);
}

export function updateMissionStatus(db: SynapseDb, missionId: string, status: Mission['status']): void {
  db.prepare('UPDATE synapse_missions SET status=? WHERE id=?').run(status, missionId);
}

export function insertStrikeTeam(db: SynapseDb, input: Partial<StrikeTeam> & { mandateText: string; operativeIds: string[]; missionIds: string[]; id?: string }): StrikeTeam {
  const id = input.id ?? randomUUID();
  db.prepare(`
    INSERT INTO synapse_strike_teams (
      id, mandate_text, operative_ids, mission_ids, blueprint_id, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `).run(
    id,
    input.mandateText,
    JSON.stringify(input.operativeIds ?? []),
    JSON.stringify(input.missionIds ?? []),
    input.blueprintId ?? null,
    input.status ?? 'deploying',
    input.createdAt ?? null,
  );
  return getStrikeTeam(db, id)!;
}

export function getStrikeTeam(db: SynapseDb, strikeTeamId: string): StrikeTeam | null {
  const row = db.prepare('SELECT * FROM synapse_strike_teams WHERE id=?').get(strikeTeamId);
  return row ? mapStrikeTeam(row) : null;
}

export function getAllStrikeTeams(db: SynapseDb): StrikeTeam[] {
  return (db.prepare('SELECT * FROM synapse_strike_teams ORDER BY created_at DESC').all() as any[]).map(mapStrikeTeam);
}

export function updateStrikeTeamStatus(db: SynapseDb, strikeTeamId: string, status: StrikeTeam['status']): void {
  db.prepare('UPDATE synapse_strike_teams SET status=? WHERE id=?').run(status, strikeTeamId);
}

export function updateStrikeTeamBlueprint(db: SynapseDb, strikeTeamId: string, blueprintId: string | null): void {
  db.prepare('UPDATE synapse_strike_teams SET blueprint_id=? WHERE id=?').run(blueprintId, strikeTeamId);
}
