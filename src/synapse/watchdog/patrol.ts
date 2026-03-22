import { nexusEventBus } from '../../engines/event-bus.js';
import { SynapseConfig } from '../config.js';
import { getAllOperatives, updateOperativeHealth } from '../operatives/crud.js';
import type { Operative, OperativeHealthState, SynapseDb } from '../types.js';

export function classifyHealth(operative: Operative, now: number): OperativeHealthState {
  if (operative.state === 'DONE' || operative.state === 'STANDDOWN') return 'IDLE';
  if (!operative.missionId) return 'IDLE';
  const ms = operative.lastSortieAt ? now - new Date(operative.lastSortieAt).getTime() : Number.POSITIVE_INFINITY;
  if (operative.state === 'SUSPENDED') return ms > SynapseConfig.watchdogZombieMs ? 'BLOCKED' : 'IDLE';
  if (ms > SynapseConfig.watchdogZombieMs) return 'ZOMBIE';
  if (ms > SynapseConfig.watchdogStallMs) return 'STALLED';
  return 'WORKING';
}

export function startWatchdogPatrol(db: SynapseDb): NodeJS.Timeout | null {
  if (!SynapseConfig.watchdogEnabled) return null;
  const timer = setInterval(() => {
    const now = Date.now();
    getAllOperatives(db).forEach((operative) => {
      const next = classifyHealth(operative, now);
      if (next === operative.healthState) return;
      updateOperativeHealth(db, operative.id, next);
      if (next === 'ZOMBIE') {
        nexusEventBus.emit('synapse.watchdog.zombie', { operativeId: operative.id });
      } else if (next === 'STALLED') {
        nexusEventBus.emit('synapse.watchdog.stall', { operativeId: operative.id });
      } else {
        nexusEventBus.emit('synapse.operative.health.changed', { operativeId: operative.id, healthState: next });
      }
    });
  }, SynapseConfig.watchdogPatrolIntervalMs);
  timer.unref();
  return timer;
}
