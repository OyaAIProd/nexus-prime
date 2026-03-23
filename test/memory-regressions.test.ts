import test from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { MemoryEngine } from '../src/engines/memory.js';
import { nexusEventBus } from '../src/engines/event-bus.js';

function createSandbox(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return {
    root,
    home,
    dbPath: path.join(root, 'memory.db'),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function corruptTableRootPage(dbPath: string, tableName: string): void {
  const db = new Database(dbPath);
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  const row = db.prepare(
    "SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName) as { rootpage?: number } | undefined;
  db.close();

  if (!row?.rootpage) {
    throw new Error(`Unable to find root page for ${tableName}`);
  }

  const bytes = fs.readFileSync(dbPath);
  const start = (row.rootpage - 1) * pageSize;
  bytes.fill(0xff, start, start + pageSize);
  fs.writeFileSync(dbPath, bytes);
}

test('MemoryEngine parameterizes access-count updates', () => {
  const sandbox = createSandbox('nexus-memory-sql');
  const memory = new MemoryEngine(sandbox.dbPath);

  (memory as any).incrementAccessTxn(["x'); DROP TABLE memories; --"]);
  const table = (memory as any).db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'",
  ).get() as { name?: string } | undefined;

  equal(table?.name, 'memories');

  memory.close();
  sandbox.cleanup();
});

test('MemoryEngine coolDown clamps entropy into the valid range', () => {
  const sandbox = createSandbox('nexus-memory-entropy');
  const memory = new MemoryEngine(sandbox.dbPath);
  const id = memory.store('Entropy clamp regression', 0.82, ['#regression']);

  (memory as any).db.prepare(
    'UPDATE memories SET entropy = ?, access_count = ? WHERE id = ?',
  ).run(0.99, 500, id);

  for (let index = 0; index < 100; index += 1) {
    memory.coolDown();
  }

  const row = (memory as any).db.prepare(
    'SELECT entropy FROM memories WHERE id = ?',
  ).get(id) as { entropy: number };
  ok(row.entropy >= 0 && row.entropy <= 1, `expected entropy in [0,1], got ${row.entropy}`);

  memory.close();
  sandbox.cleanup();
});

test('MemoryEngine recall respects recallCandidateLimit', async () => {
  const sandbox = createSandbox('nexus-memory-recall-limit');
  const memory = new MemoryEngine(sandbox.dbPath, { recallCandidateLimit: 2 });

  for (let index = 0; index < 6; index += 1) {
    memory.store(`Recall candidate ${index}`, 0.9 - index * 0.01, ['#recall']);
  }

  const db = (memory as any).db;
  const originalPrepare = db.prepare.bind(db);
  let observedLimit = -1;
  db.prepare = ((sql: string) => {
    const stmt = originalPrepare(sql);
    if (sql.includes("WHERE state = 'active'") && sql.includes('LIMIT ?')) {
      return new Proxy(stmt, {
        get(target, prop, receiver) {
          if (prop === 'all') {
            return (...args: unknown[]) => {
              observedLimit = Number(args[1]);
              return target.all(...args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    }
    return stmt;
  }) as typeof db.prepare;

  await memory.recall('Recall candidate', 5);
  equal(observedLimit, 2);

  memory.close();
  sandbox.cleanup();
});

test('MemoryEngine flushVaultSync writes dirty vault items immediately', () => {
  const sandbox = createSandbox('nexus-memory-vault');
  const memory = new MemoryEngine(sandbox.dbPath);
  const id = memory.store('Dirty vault flush item', 0.88, ['#vault']);

  memory.flushVaultSync();

  ok(fs.existsSync(path.join(sandbox.home, '.nexus-prime', 'memory-vault', 'items', `${id}.json`)));

  memory.close();
  sandbox.cleanup();
});

test('MemoryEngine emits graph sync failures and disables the mirror', () => {
  const sandbox = createSandbox('nexus-memory-graph-failure');
  const memory = new MemoryEngine(sandbox.dbPath);
  const failures: Array<{ reason: string; memoryId?: string; ts: number }> = [];
  const unsubscribe = nexusEventBus.on('graph.sync.failed', (payload) => {
    failures.push(payload);
  });

  (memory as any).graphMirror = {
    store() {
      throw new Error('graph mirror write failed');
    },
  };

  memory.store('Graph mirror failure item', 0.91, ['#graph']);

  equal(failures.length, 1);
  ok(failures[0].reason.includes('graph mirror write failed'));
  equal((memory as any).graphMirror, undefined);

  unsubscribe();
  memory.close();
  sandbox.cleanup();
});

test('MemoryEngine emits low graph coverage and forces a re-prime', () => {
  const sandbox = createSandbox('nexus-memory-graph-coverage');
  const memory = new MemoryEngine(sandbox.dbPath);
  memory.store('Graph coverage one', 0.9, ['#graph']);
  memory.store('Graph coverage two', 0.85, ['#graph']);

  let forced = false;
  (memory as any).graphMirror = {
    getGraphStats() {
      return { entities: 0, relations: 0, facts: 0, types: {} };
    },
    store() {
      return undefined;
    },
    close() {
      return undefined;
    },
  };
  (memory as any).primeGraphMirror = (_rows: unknown[], force: boolean) => {
    forced = force;
  };

  const coverageEvents: Array<{ memCount: number; graphEntities: number }> = [];
  const unsubscribe = nexusEventBus.on('graph.coverage.low', (payload) => {
    coverageEvents.push(payload);
  });

  (memory as any).checkGraphCoverage();

  equal(coverageEvents.length, 1);
  deepEqual(coverageEvents[0], { memCount: 2, graphEntities: 0 });
  equal(forced, true);

  unsubscribe();
  memory.close();
  sandbox.cleanup();
});

test('MemoryEngine repairs corrupted vocabulary tables during startup', () => {
  const sandbox = createSandbox('nexus-memory-vocabulary-repair');
  const memory = new MemoryEngine(sandbox.dbPath);
  const id = memory.store('Vocabulary repair survivor', 0.92, ['#vocabulary-repair']);
  memory.close();

  corruptTableRootPage(sandbox.dbPath, 'vocabulary_stats');

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((value) => String(value)).join(' '));
  };

  let repaired: MemoryEngine | undefined;
  try {
    repaired = new MemoryEngine(sandbox.dbPath);
    const items = repaired.queryByTags(['#vocabulary-repair']);
    ok(items.some((item) => item.id === id), 'expected stored memory to survive vocabulary repair');

    const integrity = (repaired as any).db.pragma('integrity_check', { simple: true });
    equal(integrity, 'ok');

    const stats = (repaired as any).db.prepare(
      'SELECT COUNT(*) as c FROM vocabulary_stats',
    ).get() as { c: number };
    ok(stats.c > 0, 'expected vocabulary stats to be rebuilt after repair');
    ok(
      warnings.some((warning) => warning.includes('Repaired derived vocabulary state')),
      'expected a repair warning that mentions the repaired vocabulary state',
    );
  } finally {
    console.warn = originalWarn;
    repaired?.close();
    sandbox.cleanup();
  }
});
