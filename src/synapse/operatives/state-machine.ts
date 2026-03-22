import { nexusEventBus } from '../../engines/event-bus.js';
import type { OperativeState, SynapseDb } from '../types.js';

const VALID_TRANSITIONS: Record<OperativeState, OperativeState[]> = {
  IDLE: ['ACTIVE', 'CHECKOUT', 'STANDDOWN', 'SUSPENDED', 'DONE'],
  ACTIVE: ['IDLE', 'STANDDOWN', 'SUSPENDED', 'DONE'],
  CHECKOUT: ['ACTIVE', 'IDLE', 'SUSPENDED'],
  STANDDOWN: ['IDLE', 'SUSPENDED'],
  SUSPENDED: ['IDLE', 'DONE'],
  DONE: ['IDLE'],
};

export function transitionOperative(
  db: SynapseDb,
  operativeId: string,
  nextState: OperativeState,
  suspendReason: 'budget_exceeded' | 'compaction' | 'manual' | null = null,
): void {
  const current = db.prepare('SELECT state FROM synapse_operatives WHERE id=?').get(operativeId) as { state?: OperativeState } | undefined;
  if (!current?.state) return;
  const allowed = VALID_TRANSITIONS[current.state] ?? [];
  if (!allowed.includes(nextState) && current.state !== nextState) {
    throw new Error(`[Synapse] Invalid operative transition ${current.state} -> ${nextState}`);
  }
  db.prepare(`
    UPDATE synapse_operatives
    SET state=?, suspend_reason=?, last_sortie_at=CASE WHEN ?='ACTIVE' THEN datetime('now') ELSE last_sortie_at END
    WHERE id=?
  `).run(nextState, suspendReason, nextState, operativeId);
  const health = db.prepare('SELECT health_state FROM synapse_operatives WHERE id=?').get(operativeId) as { health_state?: string } | undefined;
  nexusEventBus.emit('synapse.operative.health.changed', {
    operativeId,
    healthState: health?.health_state ?? 'IDLE',
  });
}
