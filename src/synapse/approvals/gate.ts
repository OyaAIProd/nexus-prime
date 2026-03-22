import { randomUUID } from 'crypto';
import { nexusEventBus } from '../../engines/event-bus.js';
import type { ApprovalRequest, SynapseDb } from '../types.js';

function mapApproval(row: any): ApprovalRequest {
  return {
    id: row.id,
    missionId: row.mission_id ?? null,
    operativeId: row.operative_id,
    action: row.action,
    description: row.description,
    status: row.status,
    decidedAt: row.decided_at ?? null,
    createdAt: row.created_at,
  };
}

export function requestApproval(db: SynapseDb, input: { operativeId: string; missionId?: string | null; action: string; description: string }): ApprovalRequest {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO synapse_approvals (id, mission_id, operative_id, action, description, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(id, input.missionId ?? null, input.operativeId, input.action, input.description);
  nexusEventBus.emit('synapse.approval.requested', { approvalId: id, operativeId: input.operativeId, action: input.action });
  return getApproval(db, id)!;
}

export function resolveApproval(db: SynapseDb, approvalId: string, decision: 'approved' | 'rejected'): ApprovalRequest | null {
  db.prepare('UPDATE synapse_approvals SET status=?, decided_at=datetime(\'now\') WHERE id=?').run(decision, approvalId);
  const approval = getApproval(db, approvalId);
  if (approval) {
    nexusEventBus.emit('synapse.approval.resolved', { approvalId, decision });
  }
  return approval;
}

export function getApproval(db: SynapseDb, approvalId: string): ApprovalRequest | null {
  const row = db.prepare('SELECT * FROM synapse_approvals WHERE id=?').get(approvalId);
  return row ? mapApproval(row) : null;
}

export function getPendingApprovals(db: SynapseDb): ApprovalRequest[] {
  return (db.prepare('SELECT * FROM synapse_approvals WHERE status=\'pending\' ORDER BY created_at ASC').all() as any[]).map(mapApproval);
}

export function hasPendingApprovalForMission(db: SynapseDb, missionId: string | null | undefined): boolean {
  if (!missionId) return false;
  const row = db.prepare('SELECT id FROM synapse_approvals WHERE mission_id=? AND status=\'pending\' LIMIT 1').get(missionId);
  return Boolean(row);
}
