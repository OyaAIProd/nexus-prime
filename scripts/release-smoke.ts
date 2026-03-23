import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

interface SmokeExpectation {
  label: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  expectAny?: string[];
  expectAll?: string[];
  allowTimeout?: boolean;
  stopOnMatch?: boolean;
}

interface SmokeResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

function runStep(step: SmokeExpectation): Promise<SmokeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...step.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;
    let timedOut = false;
    const timeoutMs = step.timeoutMs ?? 0;
    const shouldStopOnMatch = Boolean(step.stopOnMatch && step.expectAny?.length);

    const finalize = (exitCode: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve({ output, exitCode, timedOut });
    };

    const checkForEarlySuccess = () => {
      if (!shouldStopOnMatch || settled) return;
      const matched = step.expectAny?.some((snippet) => output.includes(snippet));
      if (!matched) return;
      finalize(0);
      child.kill('SIGTERM');
    };

    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      checkForEarlySuccess();
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
      checkForEarlySuccess();
    });
    child.on('error', (error) => finalize(null, error));
    child.on('close', (code) => finalize(code));

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!settled) child.kill('SIGKILL');
          }, 1000);
        }, timeoutMs)
      : null;
  });
}

function assertStep(step: SmokeExpectation, result: SmokeResult): void {
  const matchesExpectation = !step.expectAny?.length || step.expectAny.some((snippet) => result.output.includes(snippet));
  const matchesAllExpectation = !step.expectAll?.length || step.expectAll.every((snippet) => result.output.includes(snippet));
  if (!matchesExpectation) {
    throw new Error(`${step.label} did not emit an expected marker.\n\nOutput:\n${result.output}`);
  }
  if (!matchesAllExpectation) {
    throw new Error(`${step.label} did not emit all expected markers.\n\nOutput:\n${result.output}`);
  }
  if (result.timedOut && !step.allowTimeout) {
    throw new Error(`${step.label} timed out unexpectedly.\n\nOutput:\n${result.output}`);
  }
  if (!result.timedOut && result.exitCode !== 0) {
    throw new Error(`${step.label} exited with code ${String(result.exitCode)}.\n\nOutput:\n${result.output}`);
  }
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

function prepareCorruptVocabularyDb(root: string): {
  memoryDbPath: string;
  stateDir: string;
} {
  const stateDir = path.join(root, 'corrupt-state');
  const memoryDbPath = path.join(stateDir, 'memory.db');
  fs.mkdirSync(stateDir, { recursive: true });

  const db = new Database(memoryDbPath);
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      priority REAL NOT NULL DEFAULT 1.0,
      timestamp INTEGER NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      tier TEXT NOT NULL DEFAULT 'hippocampus',
      scope TEXT NOT NULL DEFAULT 'session',
      state TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'runtime',
      session_id TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT,
      depth INTEGER DEFAULT 0,
      entropy REAL NOT NULL DEFAULT 0.0,
      mass REAL NOT NULL DEFAULT 1.0,
      trust REAL NOT NULL DEFAULT 0.6,
      qmd_recency REAL DEFAULT NULL,
      qmd_frequency REAL DEFAULT NULL,
      qmd_relevance REAL DEFAULT NULL,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      expires_at INTEGER,
      supersedes TEXT,
      superseded_by TEXT
    );
    CREATE TABLE memory_links(
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0.5,
      type TEXT NOT NULL DEFAULT 'semantic',
      PRIMARY KEY(from_id, to_id)
    );
    CREATE TABLE token_ledger(
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      task TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens_optimized INTEGER NOT NULL,
      tokens_saved INTEGER NOT NULL,
      tokens_forwarded INTEGER NOT NULL,
      compression_ratio REAL NOT NULL,
      file_count INTEGER NOT NULL,
      usd_value_saved REAL NOT NULL
    );
    CREATE TABLE vocabulary_stats (
      term TEXT PRIMARY KEY,
      df INTEGER NOT NULL DEFAULT 1,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE vocabulary_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO vocabulary_meta(key, value) VALUES('doc_count', '1');
    INSERT INTO memories(
      id, content, priority, timestamp, tags, tier, scope, state, source,
      session_id, access_count, parent_id, depth, entropy, mass, trust,
      qmd_recency, qmd_frequency, qmd_relevance, provenance_json, expires_at,
      supersedes, superseded_by
    ) VALUES(
      'repair-seed',
      'release smoke vocabulary repair seed',
      0.9,
      1,
      '["#smoke"]',
      'prefrontal',
      'session',
      'active',
      'runtime',
      'smoke-session',
      0,
      NULL,
      0,
      0.0,
      1.0,
      0.9,
      NULL,
      NULL,
      NULL,
      '{}',
      NULL,
      NULL,
      NULL
    );
    INSERT INTO vocabulary_stats(term, df, last_seen) VALUES('seed', 1, 1);
  `);
  db.close();
  corruptTableRootPage(memoryDbPath, 'vocabulary_stats');
  return { memoryDbPath, stateDir };
}

async function main(): Promise<void> {
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-smoke-'));
  const smokeHome = path.join(smokeRoot, 'home');
  fs.mkdirSync(smokeHome, { recursive: true });
  const sharedEnv = {
    HOME: smokeHome,
    USERPROFILE: smokeHome,
  };
  const corruptFixture = prepareCorruptVocabularyDb(smokeRoot);
  const statusStateDir = path.join(smokeRoot, 'status-state');
  const mcpStateDir = path.join(smokeRoot, 'mcp-state');
  const dashboardStateDir = path.join(smokeRoot, 'dashboard-state');
  for (const dir of [statusStateDir, mcpStateDir, dashboardStateDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const statusEnv = {
    ...sharedEnv,
    NEXUS_MEMORY_DB_PATH: path.join(statusStateDir, 'memory.db'),
    NEXUS_STATE_DIR: statusStateDir,
  };
  const steps: SmokeExpectation[] = [
    {
      label: 'Bootstrap manifest',
      command: 'node',
      args: ['dist/cli.js', 'bootstrap', 'status'],
      env: statusEnv,
      expectAny: ['"clients"'],
    },
    {
      label: 'Client setup status',
      command: 'node',
      args: ['dist/cli.js', 'setup', 'status'],
      env: statusEnv,
      expectAny: ['Integration Status'],
    },
    {
      label: 'MCP startup smoke',
      command: 'node',
      args: ['dist/cli.js', 'mcp'],
      env: {
        ...sharedEnv,
        NEXUS_MEMORY_DB_PATH: path.join(mcpStateDir, 'memory.db'),
        NEXUS_STATE_DIR: mcpStateDir,
      },
      timeoutMs: 12000,
      allowTimeout: true,
      expectAny: ['MCP Server running on stdio'],
      stopOnMatch: true,
    },
    {
      label: 'MCP corrupt-vocabulary recovery smoke',
      command: 'node',
      args: ['dist/cli.js', 'mcp'],
      env: {
        ...sharedEnv,
        NEXUS_MEMORY_DB_PATH: corruptFixture.memoryDbPath,
        NEXUS_STATE_DIR: corruptFixture.stateDir,
      },
      timeoutMs: 12000,
      allowTimeout: true,
      expectAll: [
        'MCP Server running on stdio',
        'Repaired derived vocabulary state in',
      ],
      stopOnMatch: false,
    },
    {
      label: 'Dashboard boot smoke',
      command: 'node',
      args: ['dist/cli.js', 'start'],
      env: {
        ...sharedEnv,
        NEXUS_MEMORY_DB_PATH: path.join(dashboardStateDir, 'memory.db'),
        NEXUS_STATE_DIR: dashboardStateDir,
      },
      timeoutMs: 12000,
      allowTimeout: true,
      expectAny: ['Topology console listening', 'Reusing compatible dashboard', 'New dashboard started at'],
      stopOnMatch: true,
    },
  ];

  for (const step of steps) {
    process.stdout.write(`• ${step.label}... `);
    const result = await runStep(step);
    assertStep(step, result);
    process.stdout.write('ok\n');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
