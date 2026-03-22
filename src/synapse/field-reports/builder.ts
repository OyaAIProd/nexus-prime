import { randomUUID } from 'crypto';
import type { ExecutionRun } from '../../phantom/runtime.js';
import type { FieldReport, Operative } from '../types.js';

export function buildFieldReport(execution: ExecutionRun, sortieId: string, operative: Operative, missionTitle: string): FieldReport {
  const findings = execution.result || execution.workerResults.map((result) => result.learnings.join('; ')).filter(Boolean).join('\n');
  const filesChanged = Array.from(new Set(execution.workerResults.flatMap((result) => result.modifiedFiles || [])));
  const blockersEncountered = execution.state === 'failed'
    ? execution.workerResults.map((result) => result.outcome).filter(Boolean).join('; ')
    : '';
  const nextRecommendedAction = execution.state === 'merged'
    ? 'Advance to the next mission or convergence step.'
    : execution.state === 'failed'
      ? 'Inspect worker artifacts and retry with narrower scope.'
      : 'Review the execution ledger before retrying.';

  return {
    id: randomUUID(),
    sortieId,
    operativeId: operative.id,
    strikeTeamId: operative.strikeTeamId,
    missionTitle,
    findings: findings || `Run ${execution.runId} completed with state ${execution.state}.`,
    filesChanged,
    blockersEncountered,
    nextRecommendedAction,
    tokensUsed: Number(execution.tokenTelemetry?.forwardedTokens || 0),
    costUsd: Number((execution.tokenTelemetry?.forwardedTokens || 0) / 1000 * 0.01),
    ledgerPath: null,
    status: execution.state === 'merged' ? 'completed' : execution.state === 'failed' ? 'failed' : 'blocked',
    completedAt: new Date().toISOString(),
  };
}
