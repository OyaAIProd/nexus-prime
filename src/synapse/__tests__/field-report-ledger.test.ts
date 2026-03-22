import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { scheduleFieldReportLedgerExport } from '../field-reports/ledger.js';
import { fieldReportExists, restoreSynapseFromLedger } from '../field-reports/restorer.js';
import { createSynapseDb } from './helpers.js';

export async function run() {
  const { db, root } = createSynapseDb();
  const report = {
    id: 'report-1',
    sortieId: 'sortie-1',
    operativeId: 'operative-1',
    strikeTeamId: 'team-1',
    missionTitle: 'Implement login guardrails',
    findings: 'Guardrails were added successfully.',
    filesChanged: ['src/auth.ts'],
    blockersEncountered: '',
    nextRecommendedAction: 'Proceed to convergence.',
    tokensUsed: 400,
    costUsd: 0.04,
    ledgerPath: null,
    status: 'completed' as const,
    completedAt: new Date().toISOString(),
  };

  const ledgerPath = scheduleFieldReportLedgerExport(root, report);
  assert.ok(ledgerPath, 'ledger export should return a markdown path');
  assert.ok(fs.existsSync(ledgerPath!), 'field report ledger markdown should be written');
  db.close();

  const restored = createSynapseDb(root);
  const restoredCount = restoreSynapseFromLedger(restored.db, root);
  assert.strictEqual(restoredCount, 1, 'restore should ingest one report from ledger markdown');
  assert.strictEqual(fieldReportExists(restored.db, report.id), true, 'restored field report should exist in SQLite');
  assert.ok(fs.readFileSync(path.join(root, '.synapse', 'ledger', 'team-1', 'operative-1', 'report-1.md'), 'utf8').includes('Field Report'), 'ledger markdown should render a readable document');
  restored.db.close();
}
