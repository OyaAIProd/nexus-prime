import { randomUUID } from 'crypto';
import type { ArchitectsDb, Blueprint, ConvergenceRun, ConstructionLock, RelayMessage, WorkItem, WorkItemStatus, Worklist } from '../types.js';

function parseArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function parseObject(value: string | null | undefined): Record<string, string> {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function mapBlueprint(row: any): Blueprint {
  return {
    id: row.id,
    strikeTeamId: row.strike_team_id ?? null,
    title: row.title,
    workflowId: row.workflow_id ?? null,
    status: row.status,
    variables: parseObject(row.variables),
    worklistId: row.worklist_id ?? null,
    createdAt: row.created_at,
  };
}

export function mapWorklist(row: any): Worklist {
  return {
    id: row.id,
    blueprintId: row.blueprint_id,
    title: row.title,
    createdAt: row.created_at,
  };
}

export function mapWorkItem(row: any): WorkItem {
  return {
    id: row.id,
    worklistId: row.worklist_id,
    title: row.title,
    status: row.status,
    dependsOn: parseArray(row.depends_on),
    assignedOperativeId: row.assigned_operative_id ?? null,
    constructionLockId: row.construction_lock_id ?? null,
    branch: row.branch ?? null,
    mergedAt: row.merged_at ?? null,
    createdAt: row.created_at,
  };
}

export function mapConstructionLock(row: any): ConstructionLock {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    operativeId: row.operative_id,
    acquiredAt: row.acquired_at,
    releasedAt: row.released_at ?? null,
    hookRef: row.hook_ref ?? null,
  };
}

export function mapRelayMessage(row: any): RelayMessage {
  return {
    id: row.id,
    fromOperativeId: row.from_operative_id,
    toOperativeId: row.to_operative_id ?? null,
    strikeTeamId: row.strike_team_id ?? null,
    subject: row.subject,
    body: row.body,
    sentAt: row.sent_at,
    readAt: row.read_at ?? null,
    priority: row.priority,
  };
}

export function mapConvergenceRun(row: any): ConvergenceRun {
  return {
    id: row.id,
    worklistId: row.worklist_id,
    strategy: row.strategy,
    workItemIds: parseArray(row.work_item_ids),
    status: row.status,
    failedItemId: row.failed_item_id ?? null,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? null,
  };
}

export function insertBlueprint(db: ArchitectsDb, input: Partial<Blueprint> & { title: string; id?: string }): Blueprint {
  const id = input.id ?? randomUUID();
  db.prepare(`
    INSERT INTO architects_blueprints (id, strike_team_id, title, workflow_id, status, variables, worklist_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `).run(
    id,
    input.strikeTeamId ?? null,
    input.title,
    input.workflowId ?? null,
    input.status ?? 'active',
    JSON.stringify(input.variables ?? {}),
    input.worklistId ?? null,
    input.createdAt ?? null,
  );
  return getBlueprint(db, id)!;
}

export function getBlueprint(db: ArchitectsDb, blueprintId: string): Blueprint | null {
  const row = db.prepare('SELECT * FROM architects_blueprints WHERE id=?').get(blueprintId);
  return row ? mapBlueprint(row) : null;
}

export function insertWorklist(db: ArchitectsDb, input: Partial<Worklist> & { blueprintId: string; title: string; id?: string }): Worklist {
  const id = input.id ?? randomUUID();
  db.prepare('INSERT INTO architects_worklists (id, blueprint_id, title, created_at) VALUES (?, ?, ?, COALESCE(?, datetime(\'now\')))').run(
    id,
    input.blueprintId,
    input.title,
    input.createdAt ?? null,
  );
  return getWorklist(db, id)!;
}

export function getWorklist(db: ArchitectsDb, worklistId: string): Worklist | null {
  const row = db.prepare('SELECT * FROM architects_worklists WHERE id=?').get(worklistId);
  return row ? mapWorklist(row) : null;
}

export function insertWorkItem(db: ArchitectsDb, input: Partial<WorkItem> & { worklistId: string; title: string; id?: string }): WorkItem {
  const id = input.id ?? randomUUID();
  db.prepare(`
    INSERT INTO architects_work_items (
      id, worklist_id, title, status, depends_on, assigned_operative_id,
      construction_lock_id, branch, merged_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `).run(
    id,
    input.worklistId,
    input.title,
    input.status ?? 'todo',
    JSON.stringify(input.dependsOn ?? []),
    input.assignedOperativeId ?? null,
    input.constructionLockId ?? null,
    input.branch ?? null,
    input.mergedAt ?? null,
    input.createdAt ?? null,
  );
  return getWorkItem(db, id)!;
}

export function getWorkItem(db: ArchitectsDb, workItemId: string): WorkItem | null {
  const row = db.prepare('SELECT * FROM architects_work_items WHERE id=?').get(workItemId);
  return row ? mapWorkItem(row) : null;
}

export function getWorkItemsForWorklist(db: ArchitectsDb, worklistId: string): WorkItem[] {
  return (db.prepare('SELECT * FROM architects_work_items WHERE worklist_id=? ORDER BY created_at ASC').all(worklistId) as any[]).map(mapWorkItem);
}

export function upsertWorkItem(db: ArchitectsDb, input: Partial<WorkItem> & { id: string; worklistId: string; title: string }): WorkItem {
  const existing = getWorkItem(db, input.id);
  if (existing) {
    db.prepare(`
      UPDATE architects_work_items
      SET worklist_id=?, title=?, status=?, depends_on=?, assigned_operative_id=?, construction_lock_id=?, branch=?, merged_at=?
      WHERE id=?
    `).run(
      input.worklistId,
      input.title,
      input.status ?? existing.status,
      JSON.stringify(input.dependsOn ?? existing.dependsOn),
      input.assignedOperativeId ?? existing.assignedOperativeId,
      input.constructionLockId ?? existing.constructionLockId,
      input.branch ?? existing.branch,
      input.mergedAt ?? existing.mergedAt,
      input.id,
    );
    return getWorkItem(db, input.id)!;
  }
  return insertWorkItem(db, input as WorkItem);
}

export function updateWorkItemStatus(db: ArchitectsDb, workItemId: string, status: WorkItemStatus, branch?: string | null): WorkItem | null {
  db.prepare(`
    UPDATE architects_work_items
    SET status=?, branch=COALESCE(?, branch), merged_at=CASE WHEN ?='done' THEN COALESCE(merged_at, datetime('now')) ELSE merged_at END
    WHERE id=?
  `).run(status, branch ?? null, status, workItemId);
  return getWorkItem(db, workItemId);
}

export function insertConstructionLock(db: ArchitectsDb, input: Partial<ConstructionLock> & { workItemId: string; operativeId: string; id?: string }): ConstructionLock {
  const id = input.id ?? randomUUID();
  db.prepare(`
    INSERT INTO architects_construction_locks (id, work_item_id, operative_id, acquired_at, released_at, hook_ref)
    VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?, ?)
  `).run(id, input.workItemId, input.operativeId, input.acquiredAt ?? null, input.releasedAt ?? null, input.hookRef ?? null);
  return getConstructionLock(db, id)!;
}

export function getConstructionLock(db: ArchitectsDb, lockId: string): ConstructionLock | null {
  const row = db.prepare('SELECT * FROM architects_construction_locks WHERE id=?').get(lockId);
  return row ? mapConstructionLock(row) : null;
}

export function getActiveLockForWorkItem(db: ArchitectsDb, workItemId: string): ConstructionLock | null {
  const row = db.prepare('SELECT * FROM architects_construction_locks WHERE work_item_id=? AND released_at IS NULL').get(workItemId);
  return row ? mapConstructionLock(row) : null;
}

export function releaseConstructionLockRecord(db: ArchitectsDb, lockId: string): ConstructionLock | null {
  db.prepare('UPDATE architects_construction_locks SET released_at=datetime(\'now\') WHERE id=?').run(lockId);
  return getConstructionLock(db, lockId);
}

export function insertRelayMessage(db: ArchitectsDb, input: Partial<RelayMessage> & { fromOperativeId: string; subject: string; body: string; id?: string }): RelayMessage {
  const id = input.id ?? randomUUID();
  db.prepare(`
    INSERT INTO architects_relay_messages (
      id, from_operative_id, to_operative_id, strike_team_id, subject, body, sent_at, read_at, priority
    ) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?)
  `).run(
    id,
    input.fromOperativeId,
    input.toOperativeId ?? null,
    input.strikeTeamId ?? null,
    input.subject,
    input.body,
    input.sentAt ?? null,
    input.readAt ?? null,
    input.priority ?? 'normal',
  );
  return getRelayMessage(db, id)!;
}

export function getRelayMessage(db: ArchitectsDb, messageId: string): RelayMessage | null {
  const row = db.prepare('SELECT * FROM architects_relay_messages WHERE id=?').get(messageId);
  return row ? mapRelayMessage(row) : null;
}

export function getRelayInbox(db: ArchitectsDb, input: { operativeId?: string; strikeTeamId?: string; markRead?: boolean }): RelayMessage[] {
  const rows = db.prepare(`
    SELECT *
    FROM architects_relay_messages
    WHERE (
      (? IS NOT NULL AND to_operative_id = ?)
      OR (? IS NOT NULL AND strike_team_id = ?)
    )
    ORDER BY sent_at DESC
  `).all(input.operativeId ?? null, input.operativeId ?? null, input.strikeTeamId ?? null, input.strikeTeamId ?? null) as any[];
  const messages = rows.map(mapRelayMessage);
  if (input.markRead) {
    messages.forEach((message) => {
      db.prepare('UPDATE architects_relay_messages SET read_at=datetime(\'now\') WHERE id=?').run(message.id);
    });
  }
  return messages;
}

export function insertConvergenceRun(db: ArchitectsDb, input: Partial<ConvergenceRun> & { worklistId: string; workItemIds: string[]; id?: string }): ConvergenceRun {
  const id = input.id ?? randomUUID();
  db.prepare(`
    INSERT INTO architects_convergence_runs (
      id, worklist_id, strategy, work_item_ids, status, failed_item_id, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?)
  `).run(
    id,
    input.worklistId,
    input.strategy ?? 'bisecting',
    JSON.stringify(input.workItemIds ?? []),
    input.status ?? 'running',
    input.failedItemId ?? null,
    input.startedAt ?? null,
    input.completedAt ?? null,
  );
  return getConvergenceRun(db, id)!;
}

export function getConvergenceRun(db: ArchitectsDb, runId: string): ConvergenceRun | null {
  const row = db.prepare('SELECT * FROM architects_convergence_runs WHERE id=?').get(runId);
  return row ? mapConvergenceRun(row) : null;
}

export function finalizeConvergenceRun(db: ArchitectsDb, runId: string, status: ConvergenceRun['status'], failedItemId?: string | null): ConvergenceRun | null {
  db.prepare('UPDATE architects_convergence_runs SET status=?, failed_item_id=?, completed_at=datetime(\'now\') WHERE id=?').run(status, failedItemId ?? null, runId);
  return getConvergenceRun(db, runId);
}
