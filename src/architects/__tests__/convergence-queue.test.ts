import assert from 'assert';
import { execSync } from 'child_process';
import { runConvergenceQueue } from '../convergence/queue.js';
import { insertBlueprint, insertWorkItem, insertWorklist } from '../worklist/crud.js';
import { createArchitectsDb, createTempRepo } from './helpers.js';

export async function run() {
  const root = createTempRepo('nexus-convergence-');
  execSync('git branch feat-auth', { cwd: root, stdio: 'ignore' });
  execSync('git branch feat-tests', { cwd: root, stdio: 'ignore' });

  const { db } = createArchitectsDb(root);
  insertBlueprint(db, { id: 'bp-1', title: 'Blueprint', worklistId: 'wl-1' });
  insertWorklist(db, { id: 'wl-1', blueprintId: 'bp-1', title: 'Worklist' });
  insertWorkItem(db, { id: 'item-1', worklistId: 'wl-1', title: 'Auth branch', status: 'done', branch: 'feat-auth' });
  insertWorkItem(db, { id: 'item-2', worklistId: 'wl-1', title: 'Tests branch', status: 'done', branch: 'feat-tests' });

  const merged = await runConvergenceQueue(db, root, 'wl-1');
  assert.strictEqual(merged.status, 'merged', 'convergence should merge when all branches verify');

  insertWorkItem(db, { id: 'item-3', worklistId: 'wl-1', title: 'Broken branch', status: 'done', branch: 'missing-branch' });
  const failed = await runConvergenceQueue(db, root, 'wl-1');
  assert.strictEqual(failed.status, 'failed', 'convergence should fail when a branch cannot be verified');

  db.close();
}
