import assert from 'assert';
import { enforceBudget } from '../budgets/enforcer.js';
import { getOperative, insertOperative } from '../operatives/crud.js';
import { createSynapseDb } from './helpers.js';

export async function run() {
  const { db } = createSynapseDb();
  insertOperative(db, {
    id: 'budget-op',
    name: 'budget-op',
    budgetCapUsd: 10,
  });

  const warning = enforceBudget(db, 'budget-op', 7);
  assert.ok(warning, 'budget update should return the operative');
  assert.strictEqual(warning?.spentUsd, 7, 'budget warning should update spend');
  assert.strictEqual(warning?.state, 'IDLE', 'warning threshold should not suspend the operative');

  const suspended = enforceBudget(db, 'budget-op', 3);
  assert.strictEqual(suspended?.state, 'SUSPENDED', 'budget cap should suspend the operative');
  assert.strictEqual(getOperative(db, 'budget-op')?.suspendReason, 'budget_exceeded', 'budget suspension should persist the suspend reason');

  db.close();
}
