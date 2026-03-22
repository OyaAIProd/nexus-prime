import assert from 'assert';
import { classifyHealth } from '../watchdog/patrol.js';

export async function run() {
  const now = Date.now();

  assert.strictEqual(classifyHealth({
    id: 'op-working',
    name: 'op-working',
    skillId: null,
    specialistId: null,
    state: 'ACTIVE',
    suspendReason: null,
    healthState: 'IDLE',
    missionId: 'mission-1',
    strikeTeamId: null,
    budgetCapUsd: 10,
    spentUsd: 0,
    commendationScore: 0,
    sortieIntervalMs: 30000,
    lastSortieAt: new Date(now - 60_000).toISOString(),
    createdAt: new Date(now).toISOString(),
  }, now), 'WORKING');

  assert.strictEqual(classifyHealth({
    id: 'op-stalled',
    name: 'op-stalled',
    skillId: null,
    specialistId: null,
    state: 'ACTIVE',
    suspendReason: null,
    healthState: 'IDLE',
    missionId: 'mission-1',
    strikeTeamId: null,
    budgetCapUsd: 10,
    spentUsd: 0,
    commendationScore: 0,
    sortieIntervalMs: 30000,
    lastSortieAt: new Date(now - 360_000).toISOString(),
    createdAt: new Date(now).toISOString(),
  }, now), 'STALLED');

  assert.strictEqual(classifyHealth({
    id: 'op-zombie',
    name: 'op-zombie',
    skillId: null,
    specialistId: null,
    state: 'ACTIVE',
    suspendReason: null,
    healthState: 'IDLE',
    missionId: 'mission-1',
    strikeTeamId: null,
    budgetCapUsd: 10,
    spentUsd: 0,
    commendationScore: 0,
    sortieIntervalMs: 30000,
    lastSortieAt: new Date(now - 1_000_000).toISOString(),
    createdAt: new Date(now).toISOString(),
  }, now), 'ZOMBIE');

  assert.strictEqual(classifyHealth({
    id: 'op-blocked',
    name: 'op-blocked',
    skillId: null,
    specialistId: null,
    state: 'SUSPENDED',
    suspendReason: 'manual',
    healthState: 'IDLE',
    missionId: 'mission-1',
    strikeTeamId: null,
    budgetCapUsd: 10,
    spentUsd: 0,
    commendationScore: 0,
    sortieIntervalMs: 30000,
    lastSortieAt: new Date(now - 1_000_000).toISOString(),
    createdAt: new Date(now).toISOString(),
  }, now), 'BLOCKED');
}
