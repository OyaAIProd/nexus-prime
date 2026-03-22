import assert from 'assert';
import { acquireConstructionLock, releaseConstructionLock } from '../construction-locks/manager.js';
import { insertBlueprint, insertWorkItem, insertWorklist } from '../worklist/crud.js';
import { createArchitectsDb, createArchitectsProviders } from './helpers.js';

export async function run() {
  const { db, root } = createArchitectsDb();
  const providers = createArchitectsProviders(root);

  insertBlueprint(db, { id: 'bp-1', title: 'Blueprint', worklistId: 'wl-1' });
  insertWorklist(db, { id: 'wl-1', blueprintId: 'bp-1', title: 'Worklist' });
  insertWorkItem(db, { id: 'item-1', worklistId: 'wl-1', title: 'Ship auth' });

  const first = await acquireConstructionLock('operative-1', 'item-1', db, providers);
  const second = await acquireConstructionLock('operative-1', 'item-1', db, providers);
  const contested = await acquireConstructionLock('operative-2', 'item-1', db, providers);

  assert.ok(first?.id, 'first acquisition should succeed');
  assert.strictEqual(second?.id, first?.id, 'same operative should reacquire idempotently');
  assert.strictEqual(contested, null, 'contested lock should be rejected');

  await releaseConstructionLock('operative-1', 'item-1', db, 'done');
  const third = await acquireConstructionLock('operative-2', 'item-1', db, providers);
  assert.ok(third?.id, 'lock should be acquirable after release');

  db.close();
}
