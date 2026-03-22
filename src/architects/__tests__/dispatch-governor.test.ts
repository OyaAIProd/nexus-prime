import assert from 'assert';
import { ArchitectsConfig } from '../config.js';
import { DispatchGovernor } from '../dispatch/governor.js';
import { createArchitectsDb } from './helpers.js';

export async function run() {
  const { db } = createArchitectsDb();
  const originalLimit = ArchitectsConfig.maxConcurrent;

  ArchitectsConfig.maxConcurrent = -1;
  const unlimited = new DispatchGovernor(db);
  unlimited.dispatch('operative-1', 'item-1');
  assert.deepStrictEqual(unlimited.getStatus(), {
    throttled: false,
    active: 1,
    queueDepth: 0,
    limit: -1,
  }, 'default dispatch governor should bypass queueing');

  ArchitectsConfig.maxConcurrent = 1;
  const throttled = new DispatchGovernor(db);
  throttled.dispatch('operative-1', 'item-1');
  throttled.dispatch('operative-2', 'item-2');
  assert.deepStrictEqual(throttled.getStatus(), {
    throttled: true,
    active: 1,
    queueDepth: 1,
    limit: 1,
  }, 'throttled governor should queue excess work');
  throttled.complete();
  assert.deepStrictEqual(throttled.getStatus(), {
    throttled: true,
    active: 1,
    queueDepth: 0,
    limit: 1,
  }, 'completing a dispatch should promote the next queued work item');

  ArchitectsConfig.maxConcurrent = originalLimit;
  db.close();
}
