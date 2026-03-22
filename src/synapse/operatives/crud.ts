import { randomUUID } from 'crypto';
import type { Operative, SynapseDb } from '../types.js';

function mapOperative(row: any): Operative {
  return {
    id: row.id,
    name: row.name,
    skillId: row.skill_id ?? null,
    specialistId: row.specialist_id ?? null,
    state: row.state,
    suspendReason: row.suspend_reason ?? null,
    healthState: row.health_state,
    missionId: row.mission_id ?? null,
    strikeTeamId: row.strike_team_id ?? null,
    budgetCapUsd: Number(row.budget_cap_usd ?? 0),
    spentUsd: Number(row.spent_usd ?? 0),
    commendationScore: Number(row.commendation_score ?? 0),
    sortieIntervalMs: Number(row.sortie_interval_ms ?? 30_000),
    lastSortieAt: row.last_sortie_at ?? null,
    createdAt: row.created_at,
  };
}

export function insertOperative(db: SynapseDb, input: Partial<Operative> & { id?: string; name?: string }): Operative {
  const id = input.id ?? randomUUID();
  const name = input.name ?? `operative-${id.slice(0, 8)}`;
  db.prepare(`
    INSERT INTO synapse_operatives (
      id, name, skill_id, specialist_id, state, suspend_reason, health_state, mission_id,
      strike_team_id, budget_cap_usd, spent_usd, commendation_score, sortie_interval_ms,
      last_sortie_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `).run(
    id,
    name,
    input.skillId ?? null,
    input.specialistId ?? null,
    input.state ?? 'IDLE',
    input.suspendReason ?? null,
    input.healthState ?? 'IDLE',
    input.missionId ?? null,
    input.strikeTeamId ?? null,
    input.budgetCapUsd ?? 10,
    input.spentUsd ?? 0,
    input.commendationScore ?? 0,
    input.sortieIntervalMs ?? 30_000,
    input.lastSortieAt ?? null,
    input.createdAt ?? null,
  );
  return getOperative(db, id)!;
}

export function getOperative(db: SynapseDb, operativeId: string): Operative | null {
  const row = db.prepare('SELECT * FROM synapse_operatives WHERE id=?').get(operativeId);
  return row ? mapOperative(row) : null;
}

export function getOperativeByName(db: SynapseDb, name: string): Operative | null {
  const row = db.prepare('SELECT * FROM synapse_operatives WHERE name=?').get(name);
  return row ? mapOperative(row) : null;
}

export function getAllOperatives(db: SynapseDb): Operative[] {
  return (db.prepare('SELECT * FROM synapse_operatives ORDER BY created_at ASC').all() as any[]).map(mapOperative);
}

export function getActiveOperatives(db: SynapseDb): Operative[] {
  return (db.prepare('SELECT * FROM synapse_operatives WHERE state IN (\'ACTIVE\', \'CHECKOUT\', \'STANDDOWN\')').all() as any[]).map(mapOperative);
}

export function updateOperativeMission(db: SynapseDb, operativeId: string, missionId: string | null, strikeTeamId?: string | null): void {
  db.prepare('UPDATE synapse_operatives SET mission_id=?, strike_team_id=COALESCE(?, strike_team_id) WHERE id=?').run(missionId, strikeTeamId ?? null, operativeId);
}

export function updateOperativeSpend(db: SynapseDb, operativeId: string, costUsd: number): Operative | null {
  db.prepare(`
    UPDATE synapse_operatives
    SET spent_usd=spent_usd + ?, last_sortie_at=datetime('now')
    WHERE id=?
  `).run(costUsd, operativeId);
  return getOperative(db, operativeId);
}

export function updateOperativeHealth(db: SynapseDb, operativeId: string, healthState: Operative['healthState']): void {
  db.prepare('UPDATE synapse_operatives SET health_state=? WHERE id=?').run(healthState, operativeId);
}
