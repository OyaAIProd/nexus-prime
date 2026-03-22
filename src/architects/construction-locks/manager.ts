import { randomUUID } from 'crypto';
import { nexusEventBus } from '../../engines/event-bus.js';
import { getActiveLockForWorkItem, getWorkItem, insertConstructionLock, releaseConstructionLockRecord, updateWorkItemStatus } from '../worklist/crud.js';
import type { ArchitectsDb, ArchitectsProviders, ConstructionLock, WorkItemStatus } from '../types.js';

export async function acquireConstructionLock(
  operativeId: string,
  workItemId: string,
  db: ArchitectsDb,
  providers: ArchitectsProviders,
): Promise<ConstructionLock | null> {
  const current = getActiveLockForWorkItem(db, workItemId);
  if (current?.operativeId === operativeId) return current;
  if (current && current.operativeId !== operativeId) {
    nexusEventBus.emit('architects.constructionlock.contested', {
      workItemId,
      byOperativeId: current.operativeId,
      requestedBy: operativeId,
    });
    return null;
  }

  const hooks = providers.hookRuntime.resolveHookSelectors([], `architects lock ${workItemId}`, 'before-mutate');
  const dispatch = providers.hookRuntime.dispatch('before-mutate', hooks, {
    goal: `Acquire construction lock for ${workItemId}`,
    allowMutateHooks: true,
  });
  const hookRef = dispatch.events.length > 0 ? `hook-dispatch:${workItemId}` : null;
  const lock = insertConstructionLock(db, {
    id: randomUUID(),
    workItemId,
    operativeId,
    hookRef,
  });
  updateWorkItemStatus(db, workItemId, 'claimed');
  db.prepare('UPDATE architects_work_items SET assigned_operative_id=?, construction_lock_id=? WHERE id=?').run(operativeId, lock.id, workItemId);
  nexusEventBus.emit('architects.constructionlock.acquired', {
    lockId: lock.id,
    workItemId,
    operativeId,
  });
  nexusEventBus.emit('architects.workitem.claimed', { workItemId, operativeId });
  return lock;
}

export async function releaseConstructionLock(
  operativeId: string,
  workItemId: string,
  db: ArchitectsDb,
  finalStatus: WorkItemStatus,
): Promise<void> {
  const current = getActiveLockForWorkItem(db, workItemId);
  if (!current || current.operativeId !== operativeId) return;
  releaseConstructionLockRecord(db, current.id);
  db.prepare('UPDATE architects_work_items SET status=?, construction_lock_id=NULL WHERE id=?').run(finalStatus, workItemId);
  nexusEventBus.emit('architects.constructionlock.released', {
    lockId: current.id,
    workItemId,
    finalStatus,
  });
}

export function getConstructionLockState(db: ArchitectsDb, workItemId: string): { workItemId: string; locked: boolean; operativeId: string | null } {
  const lock = getActiveLockForWorkItem(db, workItemId);
  return {
    workItemId,
    locked: Boolean(lock),
    operativeId: lock?.operativeId ?? null,
  };
}
