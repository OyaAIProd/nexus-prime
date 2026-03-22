import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { CompactionSentinel } from '../src/engines/compaction-sentinel.js';
import { nexusEventBus } from '../src/engines/event-bus.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('CompactionSentinel stop removes the memory.store listener and resets counters', () => {
  const sentinel = new CompactionSentinel({ checkIntervalMs: 25 });
  sentinel.start();

  nexusEventBus.emit('memory.store', {
    id: 'memory-1',
    priority: 0.8,
    tags: ['#test'],
    tier: 'prefrontal',
  });
  equal((sentinel as any).currentStoreCount, 1);

  sentinel.stop();
  equal((sentinel as any).currentStoreCount, 0);
  equal((sentinel as any).lastStoreCount, 0);

  nexusEventBus.emit('memory.store', {
    id: 'memory-2',
    priority: 0.8,
    tags: ['#test'],
    tier: 'prefrontal',
  });
  equal((sentinel as any).currentStoreCount, 0);
});

test('CompactionSentinel restart begins from a clean counter state', () => {
  const sentinel = new CompactionSentinel({ checkIntervalMs: 25 });
  sentinel.start();
  nexusEventBus.emit('memory.store', {
    id: 'memory-3',
    priority: 0.8,
    tags: ['#test'],
    tier: 'prefrontal',
  });
  sentinel.stop();
  sentinel.start();

  equal((sentinel as any).currentStoreCount, 0);
  nexusEventBus.emit('memory.store', {
    id: 'memory-4',
    priority: 0.8,
    tags: ['#test'],
    tier: 'prefrontal',
  });
  equal((sentinel as any).currentStoreCount, 1);

  sentinel.stop();
});

test('CompactionSentinel stop clears the interval timer', async () => {
  const sentinel = new CompactionSentinel({ checkIntervalMs: 20 });
  let calls = 0;
  (sentinel as any).checkTriggers = () => {
    calls += 1;
  };

  sentinel.start();
  await sleep(55);
  ok(calls > 0, 'expected the sentinel to tick while started');

  sentinel.stop();
  const beforeWait = calls;
  await sleep(55);

  equal((sentinel as any).timer, undefined);
  equal(calls, beforeWait);
});
