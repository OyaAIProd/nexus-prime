import { nexusEventBus } from '../../engines/event-bus.js';
import { transitionOperative } from '../operatives/state-machine.js';
import { getOperative, updateOperativeSpend } from '../operatives/crud.js';
import type { Operative, SynapseDb } from '../types.js';

export function enforceBudget(db: SynapseDb, operativeId: string, costUsd: number): Operative | null {
  const operative = updateOperativeSpend(db, operativeId, costUsd);
  if (!operative) return null;
  const pct = operative.budgetCapUsd <= 0 ? 1 : operative.spentUsd / operative.budgetCapUsd;
  if (pct >= 1) {
    transitionOperative(db, operativeId, 'SUSPENDED', 'budget_exceeded');
    nexusEventBus.emit('synapse.budget.exceeded', {
      operativeId,
      spentUsd: operative.spentUsd,
      capUsd: operative.budgetCapUsd,
    });
    return getOperative(db, operativeId);
  }
  if (pct >= 0.7) {
    nexusEventBus.emit('synapse.budget.warning', {
      operativeId,
      spentUsd: operative.spentUsd,
      capUsd: operative.budgetCapUsd,
      pct,
    });
  }
  return operative;
}
