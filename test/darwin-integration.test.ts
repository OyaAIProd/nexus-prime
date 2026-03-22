import test from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DarwinLoop } from '../src/engines/darwin-loop.js';
import { nexusEventBus } from '../src/engines/event-bus.js';

function createSandbox(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return {
    root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('DarwinLoop mirrors resolved cycles into memory and emits a completion event', async () => {
  const sandbox = createSandbox('nexus-darwin');
  const memoryCalls: unknown[][] = [];
  const events: Array<{ id: string; outcome: string; targetFile: string }> = [];
  const unsubscribe = nexusEventBus.on('darwin.cycle.complete', (payload) => {
    events.push(payload);
  });
  const darwin = new DarwinLoop({
    store(...args: unknown[]) {
      memoryCalls.push(args);
      return 'memory-1';
    },
  } as any);

  const cycle = darwin.propose(
    'Preserve adaptive learning outcomes',
    'src/engines/example.ts',
    'Reject and learn',
  );

  const updated = await darwin.review(cycle.id, 'reject', ['Keep the core path stable']);

  equal(updated.outcome, 'rejected');
  equal(memoryCalls.length, 1);
  deepEqual(memoryCalls[0][2], ['#darwin', '#darwin:rejected', '#target:src/engines/example.ts']);
  equal(events.length, 1);
  deepEqual(events[0], {
    id: cycle.id,
    outcome: 'rejected',
    targetFile: 'src/engines/example.ts',
  });

  unsubscribe();
  sandbox.cleanup();
});
