import test from 'node:test';
import { equal, ok, throws } from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nexusEventBus } from '../src/engines/event-bus.js';

function prepareEnvironment(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.NEXUS_MEMORY_DB_PATH = path.join(root, 'memory.db');
  process.env.NEXUS_STATE_DIR = path.join(root, '.nexus-state');
  process.env.NEXUS_POD_PATH = path.join(root, '.nexus-pod.json');
  return root;
}

async function loadOrchestratorEngine() {
  const mod = await import('../src/engines/orchestrator.js');
  return mod.OrchestratorEngine;
}

test('OrchestratorEngine classifyIntent recognizes feature work', async () => {
  prepareEnvironment('nexus-orchestrator-intent');
  const OrchestratorEngine = await loadOrchestratorEngine();
  const orchestrator = Object.create(OrchestratorEngine.prototype) as any;
  orchestrator.decomposeTask = (task: string) => [task];

  const intent = orchestrator.classifyIntent('Build a new dashboard experience for the control plane');

  equal(intent.taskType, 'feature');
});

test('OrchestratorEngine classifyIntent keeps broad control-plane audits on engineering lanes', async () => {
  prepareEnvironment('nexus-orchestrator-control-plane');
  const OrchestratorEngine = await loadOrchestratorEngine();
  const orchestrator = Object.create(OrchestratorEngine.prototype) as any;
  orchestrator.decomposeTask = (task: string) => task.split(/\band\b/i).filter(Boolean);

  const intent = orchestrator.classifyIntent('Review the dashboard UI/UX, frontend/backend API bindings, Synapse and Architects coordination, and fix lag across the control plane');

  equal(intent.taskType, 'backend');
  ok(intent.secondaryType === 'review' || intent.secondaryType === 'frontend', 'technical audit should retain review or frontend as a meaningful secondary signal');
  ok((intent.intentScores?.backend ?? 0) > (intent.intentScores?.pm ?? 0), 'backend routing should outrank PM planning for technical audits');
  ok((intent.intentScores?.frontend ?? 0) > (intent.intentScores?.data ?? 0), 'dashboard review should not collapse into data analytics routing');
});

test('OrchestratorEngine nextRepeatedFailures only increments on failed runs', async () => {
  prepareEnvironment('nexus-orchestrator-failures');
  const OrchestratorEngine = await loadOrchestratorEngine();
  const orchestrator = Object.create(OrchestratorEngine.prototype) as any;

  equal(orchestrator.nextRepeatedFailures('partial', 2), 2);
  equal(orchestrator.nextRepeatedFailures('running', 2), 2);
  equal(orchestrator.nextRepeatedFailures('failed', 2), 3);
  equal(orchestrator.nextRepeatedFailures('merged', 2), 0);
});

test('OrchestratorEngine dispose flushes synchronously and emits lifecycle telemetry', async () => {
  prepareEnvironment('nexus-orchestrator-dispose');
  const OrchestratorEngine = await loadOrchestratorEngine();
  const orchestrator = Object.create(OrchestratorEngine.prototype) as any;
  let sentinelStopped = 0;
  let workerStopped = 0;
  let unsubscribed = 0;
  let flushReason = '';
  let vaultFlushed = 0;
  const timer = setInterval(() => undefined, 1000);
  const events: Array<{ ts: number }> = [];
  const unsubscribe = nexusEventBus.on('orchestrator.disposed', (payload) => {
    events.push(payload);
  });

  orchestrator.flushInterval = timer;
  orchestrator.unsubscribePreCompaction = () => {
    unsubscribed += 1;
  };
  orchestrator.compactionSentinel = {
    stop() {
      sentinelStopped += 1;
    },
  };
  orchestrator.memoryBackgroundWorker = {
    stop() {
      workerStopped += 1;
    },
  };
  orchestrator.memory = {
    preCompactionFlush(reason: string) {
      flushReason = reason;
    },
    flushVaultSync() {
      vaultFlushed += 1;
    },
  };

  orchestrator.dispose();

  equal(orchestrator.flushInterval, undefined);
  equal(sentinelStopped, 1);
  equal(workerStopped, 1);
  equal(unsubscribed, 1);
  equal(flushReason, 'dispose');
  equal(vaultFlushed, 1);
  equal(events.length, 1);
  ok(events[0].ts > 0);

  unsubscribe();
});

test('OrchestratorEngine circuit breaker emits tripped and open events', async () => {
  prepareEnvironment('nexus-orchestrator-circuit');
  const OrchestratorEngine = await loadOrchestratorEngine();
  const orchestrator = Object.create(OrchestratorEngine.prototype) as any;
  orchestrator.consecutiveFailures = 2;
  orchestrator.circuitOpenUntil = 0;
  orchestrator.CIRCUIT_THRESHOLD = 3;
  orchestrator.CIRCUIT_COOLDOWN_MS = 30_000;

  const tripped: Array<{ consecutiveFailures: number }> = [];
  const opened: Array<{ remainingMs: number; consecutiveFailures: number }> = [];
  const unsubscribeTripped = nexusEventBus.on('nexus.circuit-tripped', (payload) => {
    tripped.push(payload);
  });
  const unsubscribeOpened = nexusEventBus.on('nexus.circuit-open', (payload) => {
    opened.push(payload);
  });

  orchestrator.updateCircuitState('failed');
  equal(tripped.length, 1);
  equal(tripped[0].consecutiveFailures, 3);

  throws(() => orchestrator.checkCircuit(), /Orchestration circuit open/);
  equal(opened.length, 1);
  equal(opened[0].consecutiveFailures, 3);

  orchestrator.updateCircuitState('merged');
  equal(orchestrator.consecutiveFailures, 0);
  equal(orchestrator.circuitOpenUntil, 0);

  unsubscribeTripped();
  unsubscribeOpened();
});
