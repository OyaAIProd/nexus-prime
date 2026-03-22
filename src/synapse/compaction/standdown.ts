import { nexusEventBus } from '../../engines/event-bus.js';
import { SynapseConfig } from '../config.js';
import { getActiveOperatives } from '../operatives/crud.js';
import { transitionOperative } from '../operatives/state-machine.js';
import type { SynapseDb, SynapseProviders } from '../types.js';

let standdownActive = false;
let resumeTimer: NodeJS.Timeout | null = null;

export function isCompactionStanddown(): boolean {
  return standdownActive;
}

export function registerCompactionListener(db: SynapseDb, providers: SynapseProviders): () => void {
  const handler = () => {
    if (standdownActive) return;
    standdownActive = true;
    const active = getActiveOperatives(db);
    active.forEach((operative) => transitionOperative(db, operative.id, 'STANDDOWN', 'compaction'));
    nexusEventBus.emit('synapse.compaction.standdown', { operativesPaused: active.length });

    resumeTimer = setInterval(() => {
      const sessionState = providers.orchestrator.getSessionState?.();
      const latest = sessionState?.tokenSummary?.forwardedTokens ?? 0;
      if (latest < SynapseConfig.compactionBudgetTokens * 0.6) {
        if (resumeTimer) clearInterval(resumeTimer);
        resumeTimer = null;
        standdownActive = false;
        active.forEach((operative) => transitionOperative(db, operative.id, 'IDLE'));
        nexusEventBus.emit('synapse.compaction.resumed', { operativesResumed: active.length });
      }
    }, 15_000);
    resumeTimer.unref();
  };

  const unsubscribe = nexusEventBus.on('memory.pre-compaction', handler);
  return () => {
    unsubscribe();
    if (resumeTimer) clearInterval(resumeTimer);
    resumeTimer = null;
    standdownActive = false;
  };
}
