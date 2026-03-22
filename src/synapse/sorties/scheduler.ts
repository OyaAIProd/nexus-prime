import { getAllOperatives } from '../operatives/crud.js';
import { runSortie } from './runner.js';
import type { SynapseDb, SynapseProviders } from '../types.js';

export function startSortieScheduler(db: SynapseDb, providers: SynapseProviders): NodeJS.Timeout {
  const timer = setInterval(() => {
    const operatives = getAllOperatives(db).filter((operative) => operative.missionId && ['IDLE', 'CHECKOUT'].includes(operative.state));
    operatives.forEach((operative) => {
      void runSortie(db, operative, providers).catch(() => undefined);
    });
  }, 5_000);
  timer.unref();
  return timer;
}
