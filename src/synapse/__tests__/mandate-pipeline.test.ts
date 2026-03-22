import assert from 'assert';
import { executeMandatePipeline } from '../mandate/pipeline.js';
import { getAllOperatives } from '../operatives/crud.js';
import { getMissionsForStrikeTeam } from '../missions/crud.js';
import { createMemoryStub, createSkillRuntimeStub, createSynapseDb } from './helpers.js';

export async function run() {
  const { db } = createSynapseDb();
  const memory = createMemoryStub();
  const startedAt = Date.now();

  const team = await executeMandatePipeline(db, 'Build the auth module and write regression tests for login and session flows.', {
    repoRoot: process.cwd(),
    orchestrator: {} as any,
    memory: memory as any,
    sessionDNA: {} as any,
    skillRuntime: createSkillRuntimeStub([
      { name: 'auth-specialist', domain: 'authentication', instructions: 'Implement auth systems safely.' },
      { name: 'test-writer', domain: 'testing', instructions: 'Write regression tests for changed flows.' },
    ]) as any,
    knowledgeFabric: {} as any,
  }, {
    budgetUsd: 20,
    maxOperatives: 2,
  });

  const elapsedMs = Date.now() - startedAt;
  const operatives = getAllOperatives(db);
  const missions = getMissionsForStrikeTeam(db, team.id);

  assert.ok(elapsedMs < 1500, `mandate pipeline should stay bounded, received ${elapsedMs}ms`);
  assert.strictEqual(team.operativeIds.length, 2, 'mandate pipeline should hire bounded operatives');
  assert.ok(missions.length > 0, 'mandate pipeline should create missions');
  assert.strictEqual(operatives.length, 2, 'operatives should persist to SQLite');
  assert.ok(missions.every((mission) => mission.assignedOperativeId), 'each mission should be assigned to an operative');
  assert.strictEqual(memory.storeCalls.length, 1, 'mandate deployment should store a memory record');

  db.close();
}
