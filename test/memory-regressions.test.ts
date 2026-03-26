import test from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { MemoryEngine } from '../src/engines/memory.js';
import { MemoryExtractor } from '../src/engines/memory-extractor.js';
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

test('MemoryEngine maintenanceCycle purges expired rows and compacts large vault projections', () => {
  const sandbox = createSandbox('nexus-memory-maintenance');
  const memory = new MemoryEngine(sandbox.dbPath);
  const ids = Array.from({ length: 52 }, (_, index) => (
    memory.store(`Vault compaction candidate ${index}`, 0.92, ['#vault', '#maintenance'])
  ));
  const vaultDir = path.join(sandbox.home, '.nexus-prime', 'memory-vault');
  const itemsDir = path.join(vaultDir, 'items');

  memory.flushVaultSync();
  ok(fs.readdirSync(vaultDir).some((entry) => /^vault-snapshot-\d+\.json$/.test(entry)), 'expected pre-maintenance vault compaction snapshot to exist');
  equal(fs.readdirSync(itemsDir).filter((entry) => entry.endsWith('.json')).length, 0);

  (memory as any).db.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(Date.now() - 1_000, ids[0]);

  memory.maintenanceCycle();

  const deletedRow = (memory as any).db.prepare('SELECT id FROM memories WHERE id = ?').get(ids[0]) as { id?: string } | undefined;
  equal(deletedRow, undefined);
  equal(fs.existsSync(path.join(itemsDir, `${ids[0]}.json`)), false);
  equal(fs.readdirSync(itemsDir).filter((entry) => entry.endsWith('.json')).length, 0);
  ok(fs.readdirSync(vaultDir).some((entry) => /^vault-snapshot-\d+\.json$/.test(entry)), 'expected a consolidated vault snapshot');

  const index = JSON.parse(fs.readFileSync(path.join(vaultDir, 'index.json'), 'utf8')) as { items: Array<{ id: string }> };
  ok(!index.items.some((item) => item.id === ids[0]), 'expired entries should be removed from the vault index');

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

test('MemoryExtractor prefers valid LLM JSON and falls back on malformed output', () => {
  const llmExtractor = new MemoryExtractor({
    invoker: () => JSON.stringify({
      facts: [{
        content: 'Use repo-local skills from .agents/skills before inventing new workflow instructions.',
        kind: 'decision',
        confidence: 0.91,
        ephemeral: false,
        reason: 'Explicit policy preference',
      }],
    }),
  });

  const llmResult = llmExtractor.extract('Always use repo-local skills from .agents/skills first.', ['#decision'], 2);
  equal(llmResult.extractionMode, 'llm');
  equal(llmResult.facts.length, 1);
  equal(llmResult.facts[0].kind, 'decision');
  equal(llmResult.facts[0].reason, 'Explicit policy preference');

  const malformedExtractor = new MemoryExtractor({
    invoker: () => 'not-json',
  });
  const fallbackResult = malformedExtractor.extract('Operator prefers concise release notes with bullet summaries.', ['#user'], 2);
  equal(fallbackResult.extractionMode, 'heuristic');
  equal(fallbackResult.fallbackUsed, true);
  ok(fallbackResult.errors.length > 0);
  ok(fallbackResult.facts.length > 0);
});

test('MemoryEngine storeWithControlPlane supersedes hard contradictions and records reconciliation detail', () => {
  const sandbox = createSandbox('nexus-memory-contradiction');
  const memory = new MemoryEngine(sandbox.dbPath);
  const priorId = memory.store(
    'OAuth login is broken for enterprise users after the latest rollout.',
    0.9,
    ['#decision', '#auth'],
  );

  const result = memory.storeWithControlPlane(
    'OAuth login is not broken for enterprise users after the latest rollout.',
    0.88,
    ['#decision', '#auth'],
    undefined,
    0,
    {
      provenance: {
        repoId: 'repo-a',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
      },
    },
  );

  equal(result.summary.entries[0]?.action, 'UPDATE');
  equal(result.summary.entries[0]?.resolutionReason, 'hard-contradiction-supersede');
  ok((result.summary.entries[0]?.overlapScore ?? 0) >= 0.68);
  equal(result.summary.entries[0]?.extractorMode, 'heuristic');

  const priorRow = (memory as any).db.prepare(
    'SELECT state, superseded_by FROM memories WHERE id = ?',
  ).get(priorId) as { state: string; superseded_by?: string };
  equal(priorRow.state, 'expired');
  ok(priorRow.superseded_by);

  memory.close();
  sandbox.cleanup();
});

test('MemoryEngine importBundle performs fingerprint-based diff merge for v2 bundles', () => {
  const source = createSandbox('nexus-memory-export-source');
  const target = createSandbox('nexus-memory-export-target');
  const sourceMemory = new MemoryEngine(source.dbPath);
  const targetMemory = new MemoryEngine(target.dbPath);

  sourceMemory.store(
    'Repo-local .agents skills override legacy .agent skills for policy-first execution.',
    0.9,
    ['#workspace', '#policy'],
    undefined,
    0,
    {
      scope: 'project',
      provenance: {
        repoId: 'repo-a',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        lane: 'workspace',
      },
    },
  );

  const bundle = sourceMemory.exportBundle({ limit: 10 });
  equal(bundle.version, 2);
  ok(bundle.schemaVersion);
  ok(bundle.items[0]?.contentFingerprint);

  const firstImport = targetMemory.importBundle({ bundle });
  equal(firstImport.added, 1);
  equal(firstImport.updated, 0);
  equal(firstImport.skipped, 0);

  const secondImport = targetMemory.importBundle({ bundle });
  equal(secondImport.added, 0);
  equal(secondImport.updated, 0);
  equal(secondImport.skipped, 1);

  const updatedBundle = {
    ...bundle,
    items: bundle.items.map((item, index) => index === 0
      ? {
        ...item,
        priority: 0.96,
        timestamp: item.timestamp + 10_000,
        tags: [...item.tags, '#verified'],
      }
      : item),
  };
  const thirdImport = targetMemory.importBundle({ bundle: updatedBundle });
  equal(thirdImport.updated, 1);
  equal(thirdImport.skipped, 0);

  targetMemory.close();
  sourceMemory.close();
  target.cleanup();
  source.cleanup();
});

test('MemoryEngine retries transient SQLITE_BUSY failures on store', () => {
  const sandbox = createSandbox('nexus-memory-busy-retry');
  const memory = new MemoryEngine(sandbox.dbPath);
  const retryEvents: Array<{ operation: string; attempt: number }> = [];
  const unsubscribe = nexusEventBus.on('memory.sqlite.retry', (payload) => {
    retryEvents.push(payload);
  });

  const db = (memory as any).db;
  const originalPrepare = db.prepare.bind(db);
  let injected = false;
  db.prepare = ((sql: string) => {
    const stmt = originalPrepare(sql);
    if (!sql.includes('INSERT INTO memories')) {
      return stmt;
    }
    return new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === 'run') {
          return (...args: unknown[]) => {
            if (!injected) {
              injected = true;
              throw new Error('SQLITE_BUSY: database is locked');
            }
            return target.run(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }) as typeof db.prepare;

  const id = memory.store('SQLite busy retry regression', 0.81, ['#retry']);
  ok(id);
  equal(retryEvents.length, 1);
  equal(retryEvents[0].operation, 'store.insert');

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
