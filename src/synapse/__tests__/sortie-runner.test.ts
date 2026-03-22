import assert from 'assert';
import { runSortie } from '../sorties/runner.js';
import { getOperative, insertOperative } from '../operatives/crud.js';
import { insertMission } from '../missions/crud.js';
import { insertFieldReport } from '../field-reports/restorer.js';
import { createMemoryStub, createSynapseDb } from './helpers.js';

export async function run() {
  const { db, root } = createSynapseDb();

  const operative = insertOperative(db, {
    id: 'operative-1',
    name: 'operative-1',
    skillId: 'auth-specialist',
    budgetCapUsd: 10,
  });
  const mission = insertMission(db, {
    id: 'mission-1',
    strikeTeamId: 'team-1',
    title: 'Implement login guardrails',
    assignedOperativeId: operative.id,
  });
  db.prepare('UPDATE synapse_operatives SET mission_id=?, strike_team_id=? WHERE id=?').run(mission.id, 'team-1', operative.id);
  const assignedOperative = getOperative(db, operative.id)!;

  db.prepare(`
    INSERT INTO synapse_sorties (id, operative_id, mission_id, status, tokens_used, cost_usd, field_report_id, started_at, completed_at)
    VALUES ('prior-sortie', 'operative-2', ?, 'completed', 120, 0.5, 'prior-report', datetime('now', '-2 minutes'), datetime('now', '-1 minute'))
  `).run(mission.id);
  insertFieldReport(db, {
    id: 'prior-report',
    sortieId: 'prior-sortie',
    operativeId: 'operative-2',
    strikeTeamId: 'team-1',
    missionTitle: mission.title,
    findings: 'Prior sortie found a safe auth session pattern.',
    filesChanged: ['src/auth.ts'],
    blockersEncountered: '',
    nextRecommendedAction: 'Reuse the session guard.',
    tokensUsed: 120,
    costUsd: 0.5,
    ledgerPath: null,
    status: 'completed',
    completedAt: new Date().toISOString(),
  });

  const memory = createMemoryStub();
  let goal = '';
  const completed: Array<{ workItemId: string; operativeId: string; status: string }> = [];
  const sortie = await runSortie(db, assignedOperative, {
    repoRoot: root,
    orchestrator: {
      async orchestrate(inputGoal: string) {
        goal = inputGoal;
        return {
          runId: 'run-1',
          state: 'merged',
          result: 'Login guardrails shipped.',
          workerResults: [{ learnings: ['auth ok'], modifiedFiles: ['src/auth.ts'], outcome: 'ok' }],
          tokenTelemetry: { forwardedTokens: 1400 },
        };
      },
    } as any,
    memory: memory as any,
    sessionDNA: {} as any,
    skillRuntime: {} as any,
    knowledgeFabric: {} as any,
    async claimWorkItem() {
      return { id: 'lock-1' };
    },
    async completeWorkItem(workItemId: string, operativeId: string, status: 'done' | 'failed' | 'blocked') {
      completed.push({ workItemId, operativeId, status });
      return {};
    },
  });

  assert.strictEqual(sortie.status, 'completed', 'sortie should complete when orchestration succeeds');
  assert.ok(goal.includes('[Echo: 1 prior sortie(s)]'), 'sortie goal should include predecessor echo context');
  assert.deepStrictEqual(completed, [{ workItemId: mission.id, operativeId: operative.id, status: 'done' }], 'work item should be completed after a successful sortie');

  const deferred = await runSortie(db, assignedOperative, {
    repoRoot: root,
    orchestrator: { async orchestrate() { throw new Error('should-not-run'); } } as any,
    memory: memory as any,
    sessionDNA: {} as any,
    skillRuntime: {} as any,
    knowledgeFabric: {} as any,
    async claimWorkItem() {
      return null;
    },
  });
  assert.strictEqual(deferred.status, 'deferred', 'sortie should defer when the construction lock is unavailable');

  db.close();
}
