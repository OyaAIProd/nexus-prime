import { run as runApprovals } from './approvals.test.js';
import { run as runBudgets } from './budgets.test.js';
import { run as runLedger } from './field-report-ledger.test.js';
import { run as runMandate } from './mandate-pipeline.test.js';
import { run as runMcp } from './mcp-tools.test.js';
import { run as runSortie } from './sortie-runner.test.js';
import { run as runWatchdog } from './watchdog-patrol.test.js';

async function main() {
  console.log('🧪 Running Synapse tests...');
  for (const task of [runMandate, runSortie, runLedger, runWatchdog, runBudgets, runApprovals, runMcp]) {
    await task();
  }
  console.log('✅ Synapse tests passed');
}

void main();
