import { run as runBlueprint } from './blueprint-instantiate.test.js';
import { run as runConvergence } from './convergence-queue.test.js';
import { run as runConstruction } from './construction-locks.test.js';
import { run as runDispatch } from './dispatch-governor.test.js';
import { run as runMcp } from './mcp-tools.test.js';
import { run as runRelay } from './relay-messenger.test.js';

async function main() {
  console.log('🧪 Running Architects tests...');
  for (const task of [runBlueprint, runConstruction, runRelay, runConvergence, runDispatch, runMcp]) {
    await task();
  }
  console.log('✅ Architects tests passed');
}

void main();
