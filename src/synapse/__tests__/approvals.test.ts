import assert from 'assert';
import { requestApproval, resolveApproval, hasPendingApprovalForMission } from '../approvals/gate.js';
import { runSortie } from '../sorties/runner.js';
import { insertMission } from '../missions/crud.js';
import { getOperative, insertOperative } from '../operatives/crud.js';
import { createMemoryStub, createSynapseDb } from './helpers.js';

export async function run() {
  const { db, root } = createSynapseDb();
  const operative = insertOperative(db, { id: 'approval-op', name: 'approval-op' });
  const mission = insertMission(db, {
    id: 'approval-mission',
    title: 'Reset production branch',
    assignedOperativeId: operative.id,
    requiresApprovalGate: true,
  });
  db.prepare('UPDATE synapse_operatives SET mission_id=? WHERE id=?').run(mission.id, operative.id);
  const assignedOperative = getOperative(db, operative.id)!;

  const approval = requestApproval(db, {
    operativeId: operative.id,
    missionId: mission.id,
    action: 'reset',
    description: 'Reset the branch to recover from corruption',
  });
  assert.strictEqual(hasPendingApprovalForMission(db, mission.id), true, 'new approval requests should block the mission');

  const deferred = await runSortie(db, assignedOperative, {
    repoRoot: root,
    orchestrator: { async orchestrate() { throw new Error('should-not-run'); } } as any,
    memory: createMemoryStub() as any,
    sessionDNA: {} as any,
    skillRuntime: {} as any,
    knowledgeFabric: {} as any,
  });
  assert.strictEqual(deferred.status, 'deferred', 'sortie should defer while approval is pending');

  const resolved = resolveApproval(db, approval.id, 'approved');
  assert.strictEqual(resolved?.status, 'approved', 'approval should resolve to approved');
  assert.strictEqual(hasPendingApprovalForMission(db, mission.id), false, 'resolved approval should unblock the mission');

  db.close();
}
