import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { nexusEventBus } from '../../engines/event-bus.js';
import { finalizeConvergenceRun, getConvergenceRun, getWorkItemsForWorklist, insertConvergenceRun, updateWorkItemStatus } from '../worklist/crud.js';
import type { ArchitectsDb, ConvergenceRun, WorkItem } from '../types.js';

let convergencePaused = false;

export function setConvergencePaused(nextValue: boolean): void {
  convergencePaused = nextValue;
}

function attemptBatchMerge(root: string, items: WorkItem[]): void {
  for (const item of items) {
    if (!item.branch) throw new Error(`WorkItem ${item.id} missing branch`);
    try {
      execSync(`git rev-parse --verify ${item.branch}`, { cwd: root, stdio: 'ignore' });
    } catch {
      throw new Error(`WorkItem ${item.id} branch ${item.branch} failed verification`);
    }
  }
}

async function bisectMerge(root: string, items: WorkItem[]): Promise<void> {
  try {
    attemptBatchMerge(root, items);
  } catch (error) {
    if (items.length === 1) throw error;
    const mid = Math.floor(items.length / 2);
    await bisectMerge(root, items.slice(0, mid));
    await bisectMerge(root, items.slice(mid));
  }
}

export async function runConvergenceQueue(db: ArchitectsDb, repoRoot: string, worklistId: string): Promise<ConvergenceRun> {
  if (convergencePaused) {
    return insertConvergenceRun(db, {
      id: randomUUID(),
      worklistId,
      strategy: 'bisecting',
      workItemIds: [],
      status: 'deferred',
    });
  }
  const ready = getWorkItemsForWorklist(db, worklistId)
    .filter((item) => item.status === 'done' && !item.mergedAt && item.branch);

  const run = insertConvergenceRun(db, {
    id: randomUUID(),
    worklistId,
    strategy: 'bisecting',
    workItemIds: ready.map((item) => item.id),
    status: 'running',
  });
  nexusEventBus.emit('architects.convergence.started', { runId: run.id, worklistId, itemCount: ready.length });

  try {
    if (ready.length > 0) {
      await bisectMerge(repoRoot, ready);
      ready.forEach((item) => updateWorkItemStatus(db, item.id, 'done', item.branch));
    }
    finalizeConvergenceRun(db, run.id, 'merged');
    nexusEventBus.emit('architects.convergence.merged', { runId: run.id, worklistId });
  } catch (error: any) {
    finalizeConvergenceRun(db, run.id, 'failed');
    nexusEventBus.emit('architects.convergence.failed', { runId: run.id, worklistId, error: String(error?.message ?? error) });
  }
  return getConvergenceRun(db, run.id)!;
}
