import { randomUUID } from 'crypto';
import { nexusEventBus } from '../../engines/event-bus.js';
import { insertBlueprint, insertWorkItem, insertWorklist, getBlueprint, getWorklist } from '../worklist/crud.js';
import type { ArchitectsDb, ArchitectsProviders, Blueprint, WorkItem, Worklist } from '../types.js';

function interpolate(value: string, variables: Record<string, string>): string {
  return value.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? '');
}

export function instantiateBlueprint(
  db: ArchitectsDb,
  providers: ArchitectsProviders,
  input: { title: string; workflowId: string; variables?: Record<string, string>; strikeTeamId?: string | null },
): { blueprint: Blueprint; worklist: Worklist; items: WorkItem[] } {
  const workflow = providers.workflowRuntime.getArtifact(input.workflowId) ?? providers.workflowRuntime.findByName(input.workflowId);
  if (!workflow) {
    throw new Error(`[Architects] Unknown workflowId: ${input.workflowId}`);
  }
  const blueprintId = randomUUID();
  const worklistId = randomUUID();
  const variables = input.variables ?? {};

  const items = db.transaction(() => {
    insertBlueprint(db, {
      id: blueprintId,
      strikeTeamId: input.strikeTeamId ?? null,
      title: input.title,
      workflowId: workflow.workflowId,
      status: 'active',
      variables,
      worklistId,
    });
    insertWorklist(db, {
      id: worklistId,
      blueprintId,
      title: input.title,
    });
    return workflow.steps.map((step) => insertWorkItem(db, {
      id: randomUUID(),
      worklistId,
      title: interpolate(step.title, variables),
      status: 'todo',
      dependsOn: [],
      assignedOperativeId: null,
      constructionLockId: null,
      branch: null,
      mergedAt: null,
      createdAt: new Date().toISOString(),
    }));
  })();

  nexusEventBus.emit('architects.blueprint.instantiated', {
    blueprintId,
    worklistId,
    workItemCount: items.length,
  });
  nexusEventBus.emit('architects.worklist.created', {
    worklistId,
    blueprintId,
  });

  return {
    blueprint: getBlueprint(db, blueprintId)!,
    worklist: getWorklist(db, worklistId)!,
    items,
  };
}
