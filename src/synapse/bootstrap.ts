import { KnowledgeFabricEngine } from '../engines/knowledge-fabric.js';
import { createSkillRuntime } from '../engines/skill-runtime.js';
import { nexusEventBus } from '../engines/event-bus.js';
import { SynapseConfig } from './config.js';
import { openSynapseDb } from './db/client.js';
import { restoreSynapseFromLedger, insertFieldReport } from './field-reports/restorer.js';
import { startLedgerBatchCommitter } from './field-reports/ledger.js';
import { registerCompactionListener } from './compaction/standdown.js';
import { startWatchdogPatrol } from './watchdog/patrol.js';
import { executeMandatePipeline } from './mandate/pipeline.js';
import { requestApproval, resolveApproval, getPendingApprovals } from './approvals/gate.js';
import { getAllStrikeTeams, getStrikeTeam } from './missions/crud.js';
import { getAllOperatives, getOperative } from './operatives/crud.js';
import { queryEcho } from './echo/query.js';
import { runSortieByOperativeId } from './sorties/runner.js';
import { startSortieScheduler } from './sorties/scheduler.js';
import type { FieldReport, SynapseCoordinationBridge, SynapseProviders, SynapseRuntime } from './types.js';

interface InitSynapseOptions {
  repoRoot: string;
  orchestrator: SynapseProviders['orchestrator'];
  memory: SynapseProviders['memory'];
  sessionDNA: SynapseProviders['sessionDNA'];
  coordination?: SynapseCoordinationBridge;
}

function createProviders(options: InitSynapseOptions): SynapseProviders {
  return {
    repoRoot: options.repoRoot,
    orchestrator: options.orchestrator,
    memory: options.memory,
    sessionDNA: options.sessionDNA,
    skillRuntime: createSkillRuntime(undefined, undefined, options.repoRoot),
    knowledgeFabric: new KnowledgeFabricEngine({ repoRoot: options.repoRoot, memory: options.memory }),
    coordination: options.coordination,
    claimWorkItem: options.coordination
      ? (workItemId, operativeId) => options.coordination!.claimWorkItem(workItemId, operativeId)
      : undefined,
    completeWorkItem: options.coordination
      ? (workItemId, operativeId, status) => options.coordination!.completeWorkItem(workItemId, operativeId, status)
      : undefined,
  };
}

export function initSynapse(options: InitSynapseOptions): SynapseRuntime | null {
  if (!SynapseConfig.enabled) return null;

  const db = openSynapseDb(options.repoRoot);
  const providers = createProviders(options);
  restoreSynapseFromLedger(db, options.repoRoot);
  const stopCompaction = registerCompactionListener(db, providers);
  const hasOperative = !!process.env.SYNAPSE_OPERATIVE_ID;
  const watchdogTimer = hasOperative ? startWatchdogPatrol(db) : undefined;
  const scheduler = hasOperative ? startSortieScheduler(db, providers) : undefined;
  if (hasOperative) startLedgerBatchCommitter();

  const blockedListener = (payload: { operativeId?: string; reason?: string }) => {
    if (payload.operativeId) {
      db.prepare('UPDATE synapse_operatives SET health_state=\'BLOCKED\', state=\'SUSPENDED\', suspend_reason=\'manual\' WHERE id=?').run(payload.operativeId);
      nexusEventBus.emit('synapse.operative.health.changed', { operativeId: payload.operativeId, healthState: 'BLOCKED' });
      providers.memory.store(`[Architects:Blocked] ${payload.operativeId} ${payload.reason ?? ''}`.trim(), 0.82, ['#synapse', '#blocked']);
    }
  };
  const stallListener = ({ operativeId }: { operativeId: string }) => {
    const operative = getOperative(db, operativeId);
    if (operative) {
      db.prepare('UPDATE synapse_operatives SET health_state=\'STALLED\' WHERE id=?').run(operativeId);
      nexusEventBus.emit('synapse.operative.health.changed', { operativeId, healthState: 'STALLED' });
    }
  };
  const zombieListener = ({ operativeId }: { operativeId: string }) => {
    db.prepare('UPDATE synapse_operatives SET health_state=\'ZOMBIE\', state=\'SUSPENDED\', suspend_reason=\'manual\' WHERE id=?').run(operativeId);
    nexusEventBus.emit('synapse.operative.health.changed', { operativeId, healthState: 'ZOMBIE' });
  };
  const failedConvergenceListener = ({ worklistId, error }: { worklistId: string; error?: string }) => {
    providers.memory.store(`[Architects:ConvergenceFailed] ${worklistId} ${error ?? ''}`.trim(), 0.8, ['#synapse', '#architects', '#convergence']);
  };

  const unsubBlocked = nexusEventBus.on('architects.workitem.blocked', blockedListener);
  const unsubStall = nexusEventBus.on('architects.sentinel.stall', stallListener);
  const unsubZombie = nexusEventBus.on('architects.sentinel.zombie', zombieListener);
  const unsubConvergence = nexusEventBus.on('architects.convergence.failed', failedConvergenceListener);
  nexusEventBus.emit('synapse.ready', { version: '5.0.0' });
  console.error('[Synapse] Initialized. Set SYNAPSE_OPERATIVE_ID to activate operative mode.');

  return {
    db,
    providers,
    executeMandatePipeline: (mandateText, opts) => executeMandatePipeline(db, mandateText, providers, opts),
    runSortie: (operativeId) => runSortieByOperativeId(db, operativeId, providers),
    requestApproval: (input) => requestApproval(db, input),
    resolveApproval: (approvalId, decision) => resolveApproval(db, approvalId, decision),
    noteMissionProgress: (operativeId, missionId, note) => {
      providers.memory.store(`[Synapse:Progress] ${operativeId}:${missionId ?? 'none'} ${note}`, 0.72, ['#synapse', '#progress']);
      return note;
    },
    submitFieldReport: (report: FieldReport) => {
      insertFieldReport(db, report);
      return report;
    },
    getStrikeTeamStatus: (strikeTeamId?: string) => strikeTeamId ? getStrikeTeam(db, strikeTeamId) : getAllStrikeTeams(db),
    getOperativeHealth: (operativeId?: string) => operativeId ? getOperative(db, operativeId) : getAllOperatives(db),
    queryEcho: ({ missionId, missionTitle, currentOperativeId }) => queryEcho(db, missionId ?? null, missionTitle, currentOperativeId, providers.memory),
    getPendingApprovals: () => getPendingApprovals(db),
    stop: () => {
      stopCompaction();
      if (watchdogTimer) clearInterval(watchdogTimer);
      if (scheduler) clearInterval(scheduler);
      unsubBlocked();
      unsubStall();
      unsubZombie();
      unsubConvergence();
      db.close();
    },
  };
}
