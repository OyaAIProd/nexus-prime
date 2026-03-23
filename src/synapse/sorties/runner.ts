import { randomUUID } from 'crypto';
import { nexusEventBus } from '../../engines/event-bus.js';
import { SynapseBudgetExceededError, SynapseError } from '../errors.js';
import { SynapseConfig } from '../config.js';
import { isCompactionStanddown } from '../compaction/standdown.js';
import { buildFieldReport } from '../field-reports/builder.js';
import { scheduleFieldReportLedgerExport } from '../field-reports/ledger.js';
import { insertFieldReport } from '../field-reports/restorer.js';
import { queryEcho } from '../echo/query.js';
import { hasPendingApprovalForMission } from '../approvals/gate.js';
import { enforceBudget } from '../budgets/enforcer.js';
import { getMission, updateMissionStatus, updateStrikeTeamStatus } from '../missions/crud.js';
import { getOperative } from '../operatives/crud.js';
import { transitionOperative } from '../operatives/state-machine.js';
import type { Mission, Operative, Sortie, SynapseDb, SynapseProviders } from '../types.js';

function mapSortie(row: any): Sortie {
  return {
    id: row.id,
    operativeId: row.operative_id,
    missionId: row.mission_id ?? null,
    status: row.status,
    tokensUsed: Number(row.tokens_used ?? 0),
    costUsd: Number(row.cost_usd ?? 0),
    fieldReportId: row.field_report_id ?? null,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? null,
  };
}

function insertSortie(db: SynapseDb, sortie: Partial<Sortie> & { id?: string; operativeId: string; missionId?: string | null }): Sortie {
  const id = sortie.id ?? randomUUID();
  db.prepare(`
    INSERT INTO synapse_sorties (id, operative_id, mission_id, status, tokens_used, cost_usd, field_report_id, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(
    id,
    sortie.operativeId,
    sortie.missionId ?? null,
    sortie.status ?? 'running',
    sortie.tokensUsed ?? 0,
    sortie.costUsd ?? 0,
    sortie.fieldReportId ?? null,
    sortie.completedAt ?? null,
  );
  return getSortie(db, id)!;
}

export function getSortie(db: SynapseDb, sortieId: string): Sortie | null {
  const row = db.prepare('SELECT * FROM synapse_sorties WHERE id=?').get(sortieId);
  return row ? mapSortie(row) : null;
}

function completeSortie(db: SynapseDb, sortieId: string, updates: Partial<Sortie>): void {
  db.prepare(`
    UPDATE synapse_sorties
    SET status=?, tokens_used=?, cost_usd=?, field_report_id=?, completed_at=datetime('now')
    WHERE id=?
  `).run(
    updates.status ?? 'completed',
    updates.tokensUsed ?? 0,
    updates.costUsd ?? 0,
    updates.fieldReportId ?? null,
    sortieId,
  );
}

function createSyntheticSortie(db: SynapseDb, operative: Operative, mission: Mission | null, status: Sortie['status']): Sortie {
  return insertSortie(db, {
    operativeId: operative.id,
    missionId: mission?.id ?? null,
    status,
    tokensUsed: 0,
    costUsd: 0,
    fieldReportId: null,
    completedAt: new Date().toISOString(),
  });
}

export async function runSortie(db: SynapseDb, operative: Operative, providers: SynapseProviders): Promise<Sortie> {
  const mission = getMission(db, operative.missionId);
  if (!mission) {
    return createSyntheticSortie(db, operative, null, 'failed');
  }
  if (operative.spentUsd >= operative.budgetCapUsd && operative.budgetCapUsd > 0) {
    throw new SynapseBudgetExceededError(`[Synapse] Operative ${operative.id} exceeded budget.`);
  }
  if (isCompactionStanddown()) {
    return createSyntheticSortie(db, operative, mission, 'interrupted_compaction');
  }
  if (mission.requiresApprovalGate && hasPendingApprovalForMission(db, mission.id)) {
    return createSyntheticSortie(db, operative, mission, 'deferred');
  }

  const echo = SynapseConfig.echoEnabled
    ? await queryEcho(db, mission.id, mission.title, operative.id, providers.memory)
    : { found: false, summary: '', predecessorSortieIds: [], priorBlockers: [] };
  const goal = echo.found ? `${echo.summary}\n\nCURRENT MISSION: ${mission.title}` : mission.title;
  const worklistId = mission.strikeTeamId ? providers.coordination?.getWorklistId(mission.strikeTeamId) ?? null : null;
  const correlationId = mission.id;
  if (providers.claimWorkItem) {
    const lock = await providers.claimWorkItem(mission.id, operative.id);
    if (!lock) {
      providers.coordination?.publish({
        phase: 'worklist',
        summary: `Work item ${mission.id} is already claimed`,
        strikeTeamId: mission.strikeTeamId,
        worklistId,
        workItemId: mission.id,
        operativeId: operative.id,
        correlationId,
        status: 'deferred',
      });
      return createSyntheticSortie(db, operative, mission, 'deferred');
    }
    transitionOperative(db, operative.id, 'CHECKOUT');
  }

  const sortie = insertSortie(db, {
    operativeId: operative.id,
    missionId: mission.id,
    status: 'running',
  });
  transitionOperative(db, operative.id, 'ACTIVE');
  updateMissionStatus(db, mission.id, 'active');
  nexusEventBus.emit('synapse.sortie.started', {
    sortieId: sortie.id,
    operativeId: operative.id,
    missionId: mission.id,
    workItemId: mission.id,
    strikeTeamId: mission.strikeTeamId,
    worklistId,
    correlationId,
  });
  providers.coordination?.publish({
    phase: 'sortie',
    summary: `Sortie started for ${mission.title}`,
    strikeTeamId: mission.strikeTeamId,
    worklistId,
    workItemId: mission.id,
    operativeId: operative.id,
    sortieId: sortie.id,
    correlationId,
    status: 'running',
  });
  if (echo.found) {
    nexusEventBus.emit('synapse.echo.fired', {
      operativeId: operative.id,
      predecessorCount: echo.predecessorSortieIds.length,
    });
  }

  try {
    const execution = await providers.orchestrator.orchestrate(goal, {
      files: [],
      workers: 1,
      skillNames: operative.skillId ? [operative.skillId] : [],
      specialistSelectors: operative.specialistId ? [operative.specialistId] : [],
      executionMode: 'autonomous',
    });
    const report = buildFieldReport(execution, sortie.id, operative, mission.title);
    const ledgerPath = scheduleFieldReportLedgerExport(providers.repoRoot, report);
    report.ledgerPath = ledgerPath;
    insertFieldReport(db, report);
    completeSortie(db, sortie.id, {
      status: execution.state === 'failed' ? 'failed' : 'completed',
      tokensUsed: report.tokensUsed,
      costUsd: report.costUsd,
      fieldReportId: report.id,
    });
    const updated = enforceBudget(db, operative.id, report.costUsd);
    if (!updated) {
      throw new SynapseError(`[Synapse] Unable to update operative budget for ${operative.id}`);
    }
    transitionOperative(db, operative.id, updated.state === 'SUSPENDED' ? 'SUSPENDED' : 'IDLE', updated.suspendReason ?? null);
    if (report.status === 'completed') {
      updateMissionStatus(db, mission.id, 'done');
      nexusEventBus.emit('synapse.mission.completed', { missionId: mission.id });
    } else {
      updateMissionStatus(db, mission.id, report.status === 'failed' ? 'failed' : 'blocked');
    }
    if (providers.completeWorkItem) {
      await providers.completeWorkItem(mission.id, operative.id, report.status === 'completed' ? 'done' : report.status === 'failed' ? 'failed' : 'blocked');
    }
    if (mission.strikeTeamId) {
      const remaining = db.prepare(`
        SELECT COUNT(*) AS count
        FROM synapse_missions
        WHERE strike_team_id=? AND status NOT IN ('done', 'failed')
      `).get(mission.strikeTeamId) as { count?: number };
      if ((remaining?.count ?? 0) === 0) {
        updateStrikeTeamStatus(db, mission.strikeTeamId, 'done');
        nexusEventBus.emit('synapse.striketeam.completed', { strikeTeamId: mission.strikeTeamId });
      } else {
        updateStrikeTeamStatus(db, mission.strikeTeamId, 'active');
      }
    }
    nexusEventBus.emit('synapse.fieldreport.submitted', {
      fieldReportId: report.id,
      operativeId: operative.id,
      status: report.status,
      missionId: mission.id,
      strikeTeamId: mission.strikeTeamId,
      worklistId,
      correlationId,
      runId: execution.runId,
    });
    nexusEventBus.emit('synapse.sortie.completed', {
      sortieId: sortie.id,
      operativeId: operative.id,
      missionId: mission.id,
      workItemId: mission.id,
      strikeTeamId: mission.strikeTeamId,
      worklistId,
      correlationId,
      runId: execution.runId,
      status: report.status,
      tokensUsed: report.tokensUsed,
    });
    providers.coordination?.publish({
      phase: 'field-report',
      summary: `Sortie ${sortie.id} finished with ${report.status}`,
      strikeTeamId: mission.strikeTeamId,
      worklistId,
      workItemId: mission.id,
      operativeId: operative.id,
      sortieId: sortie.id,
      runId: execution.runId,
      correlationId,
      status: report.status,
    });
    return getSortie(db, sortie.id)!;
  } catch (error: any) {
    completeSortie(db, sortie.id, { status: 'failed', tokensUsed: 0, costUsd: 0 });
    transitionOperative(db, operative.id, 'IDLE');
    updateMissionStatus(db, mission.id, 'failed');
    if (providers.completeWorkItem) {
      await providers.completeWorkItem(mission.id, operative.id, 'failed').catch(() => undefined);
    }
    nexusEventBus.emit('synapse.sortie.failed', {
      sortieId: sortie.id,
      operativeId: operative.id,
      missionId: mission.id,
      workItemId: mission.id,
      strikeTeamId: mission.strikeTeamId,
      worklistId,
      correlationId,
      error: String(error?.message ?? error),
    });
    providers.coordination?.publish({
      phase: 'field-report',
      summary: `Sortie ${sortie.id} failed for ${mission.title}`,
      strikeTeamId: mission.strikeTeamId,
      worklistId,
      workItemId: mission.id,
      operativeId: operative.id,
      sortieId: sortie.id,
      correlationId,
      status: 'failed',
    });
    throw error;
  }
}

export async function runSortieByOperativeId(db: SynapseDb, operativeId: string, providers: SynapseProviders): Promise<Sortie> {
  const operative = getOperative(db, operativeId);
  if (!operative) throw new SynapseError(`[Synapse] Unknown operative ${operativeId}`);
  return runSortie(db, operative, providers);
}
