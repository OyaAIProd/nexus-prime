import path from 'path';
import { PersistentWorkLedger } from '../engines/work-ledger.js';
import { createHookRuntime } from '../engines/hook-runtime.js';
import { createWorkflowRuntime } from '../engines/workflow-runtime.js';
import { nexusNetRelay } from '../engines/nexusnet-relay.js';
import { nexusEventBus } from '../engines/event-bus.js';
import { ArchitectsConfig } from './config.js';
import { openArchitectsDb } from './db/client.js';
import { instantiateBlueprint } from './blueprints/instantiate.js';
import { acquireConstructionLock, releaseConstructionLock } from './construction-locks/manager.js';
import { sendRelay } from './relay/messenger.js';
import { getRelayInbox } from './relay/inbox.js';
import { ArchitectsWard } from './ward/supervisor.js';
import { ArchitectsSentinel } from './sentinel/patrol.js';
import { runConvergenceQueue, setConvergencePaused } from './convergence/queue.js';
import { DispatchGovernor } from './dispatch/governor.js';
import { getWorklist, getWorkItemsForWorklist, insertBlueprint, insertWorklist, upsertWorkItem, updateWorkItemStatus } from './worklist/crud.js';
import type { ArchitectsProviders, ArchitectsRuntime, WorkItemStatus } from './types.js';

interface InitArchitectsOptions {
  repoRoot: string;
}

export function initArchitects(options: InitArchitectsOptions): ArchitectsRuntime | null {
  if (!ArchitectsConfig.enabled) return null;
  const db = openArchitectsDb(options.repoRoot);
  const providers: ArchitectsProviders = {
    repoRoot: options.repoRoot,
    workflowRuntime: createWorkflowRuntime(undefined, options.repoRoot),
    hookRuntime: createHookRuntime(undefined, options.repoRoot),
    ledger: new PersistentWorkLedger(path.join(options.repoRoot, '.architects', 'ledger')),
    relay: nexusNetRelay,
  };

  const operativeActivity = new Map<string, { strikeTeamId: string | null; lastSortieAt: string | null }>();
  const knownOperatives = new Set<string>();
  const implicitWorklistByTeam = new Map<string, string>();
  const ward = new ArchitectsWard(db, options.repoRoot, operativeActivity);
  ward.start();
  const dispatchGovernor = new DispatchGovernor(db);

  const ensureImplicitWorklist = (strikeTeamId: string) => {
    const existing = implicitWorklistByTeam.get(strikeTeamId);
    if (existing) return existing;
    const blueprintId = `implicit-blueprint:${strikeTeamId}`;
    const worklistId = `implicit-worklist:${strikeTeamId}`;
    insertBlueprint(db, {
      id: blueprintId,
      strikeTeamId,
      title: `Strike Team ${strikeTeamId}`,
      workflowId: null,
      status: 'active',
      variables: {},
      worklistId,
    });
    insertWorklist(db, {
      id: worklistId,
      blueprintId,
      title: `Strike Team ${strikeTeamId}`,
    });
    implicitWorklistByTeam.set(strikeTeamId, worklistId);
    ward.registerStrikeTeam(strikeTeamId);
    return worklistId;
  };

  const onOperativeHired = ({ operativeId, strikeTeamId }: { operativeId: string; strikeTeamId: string }) => {
    knownOperatives.add(operativeId);
    operativeActivity.set(operativeId, { strikeTeamId, lastSortieAt: null });
    ensureImplicitWorklist(strikeTeamId);
  };
  const onMissionAssigned = ({ operativeId, missionId, title }: { operativeId: string; missionId: string; title: string }) => {
    const activity = operativeActivity.get(operativeId);
    const strikeTeamId = activity?.strikeTeamId ?? null;
    if (!strikeTeamId) return;
    const worklistId = ensureImplicitWorklist(strikeTeamId);
    upsertWorkItem(db, {
      id: missionId,
      worklistId,
      title,
      status: 'todo',
      assignedOperativeId: operativeId,
      constructionLockId: null,
      dependsOn: [],
      branch: null,
      mergedAt: null,
      createdAt: new Date().toISOString(),
    });
  };
  const onSortieCompleted = ({ operativeId, missionId, status }: { operativeId: string; missionId: string | null; status: string }) => {
    const activity = operativeActivity.get(operativeId);
    if (activity) {
      activity.lastSortieAt = new Date().toISOString();
      operativeActivity.set(operativeId, activity);
    }
    if (!missionId) return;
    updateWorkItemStatus(db, missionId, status === 'completed' ? 'done' : status === 'failed' ? 'failed' : 'blocked');
  };
  const onStriketeamDeployed = ({ strikeTeamId }: { strikeTeamId: string }) => {
    ensureImplicitWorklist(strikeTeamId);
  };
  const onStanddown = () => setConvergencePaused(true);
  const onResumed = () => setConvergencePaused(false);

  const unsubOperative = nexusEventBus.on('synapse.operative.hired', onOperativeHired);
  const unsubMission = nexusEventBus.on('synapse.mission.assigned', onMissionAssigned);
  const unsubSortie = nexusEventBus.on('synapse.sortie.completed', onSortieCompleted);
  const unsubTeam = nexusEventBus.on('synapse.striketeam.deployed', onStriketeamDeployed);
  const unsubStanddown = nexusEventBus.on('synapse.compaction.standdown', onStanddown);
  const unsubResumed = nexusEventBus.on('synapse.compaction.resumed', onResumed);
  nexusEventBus.emit('architects.ready', { version: '5.0.0' });

  return {
    db,
    providers,
    instantiateBlueprint: (input) => instantiateBlueprint(db, providers, input),
    getWorklist: (worklistId) => ({
      worklist: getWorklist(db, worklistId),
      items: getWorkItemsForWorklist(db, worklistId),
    }),
    getWorklistForStrikeTeam: (strikeTeamId: string) => implicitWorklistByTeam.get(strikeTeamId) ?? `implicit-worklist:${strikeTeamId}`,
    claimWorkItem: async (workItemId, operativeId) => {
      dispatchGovernor.dispatch(operativeId, workItemId);
      return acquireConstructionLock(operativeId, workItemId, db, providers);
    },
    completeWorkItem: async (workItemId, operativeId, status: WorkItemStatus, branch?: string | null) => {
      await releaseConstructionLock(operativeId, workItemId, db, status);
      const item = updateWorkItemStatus(db, workItemId, status, branch ?? null);
      if (item) {
        providers.ledger.record(`architects-${workItemId}`, item, `Architects work item ${workItemId} -> ${status}`);
        if (status === 'blocked') {
          nexusEventBus.emit('architects.workitem.blocked', {
            workItemId,
            operativeId,
            reason: 'marked-blocked',
          });
        } else {
          nexusEventBus.emit('architects.workitem.completed', {
            workItemId,
            operativeId,
            status,
          });
        }
      }
      dispatchGovernor.complete();
      return item;
    },
    sendRelay: (input) => sendRelay(db, providers, knownOperatives, input),
    getRelayInbox: (input = {}) => getRelayInbox(db, input),
    getSentinelReport: async (strikeTeamId: string) => {
      ward.registerStrikeTeam(strikeTeamId);
      const sentinel = new ArchitectsSentinel(db, strikeTeamId, options.repoRoot, operativeActivity);
      return sentinel.patrol();
    },
    runConvergenceQueue: (worklistId: string) => runConvergenceQueue(db, options.repoRoot, worklistId),
    getDispatchStatus: () => dispatchGovernor.getStatus(),
    getWardEscalations: () => ward.getEscalations(),
    stop: () => {
      ward.stop();
      unsubOperative();
      unsubMission();
      unsubSortie();
      unsubTeam();
      unsubStanddown();
      unsubResumed();
      db.close();
    },
  };
}
