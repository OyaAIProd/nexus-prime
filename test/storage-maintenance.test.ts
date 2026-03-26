import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { NgramIndex } from '../src/engines/ngram-index.js';
import { KnowledgeFabricEngine } from '../src/engines/knowledge-fabric.js';

function createStateSandbox(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const previous = {
    nexusStateDir: process.env.NEXUS_STATE_DIR,
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
  };
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  process.env.NEXUS_STATE_DIR = root;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return {
    root,
    restore() {
      if (previous.nexusStateDir === undefined) {
        delete process.env.NEXUS_STATE_DIR;
      } else {
        process.env.NEXUS_STATE_DIR = previous.nexusStateDir;
      }
      if (previous.home === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previous.home;
      }
      if (previous.userProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previous.userProfile;
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('NgramIndex optimizeStorage vacuums reclaimed pages', () => {
  const sandbox = createStateSandbox('nexus-ngram-maintenance');
  const index = new NgramIndex(path.join(sandbox.root, 'ngram-index.db'));

  try {
    index.addDocuments(Array.from({ length: 160 }, (_, index) => ({
      id: `doc-${index}`,
      text: `token budget maintenance ${index} ${'x'.repeat(3_500)}`,
    })));
    index.rebuild([]);

    const freeBefore = Number((index as any).db.pragma('freelist_count', { simple: true }));
    ok(freeBefore > 0, `expected free pages before vacuum, got ${freeBefore}`);

    (index as any).optimizeStorage(true);

    const freeAfter = Number((index as any).db.pragma('freelist_count', { simple: true }));
    equal(freeAfter, 0);
  } finally {
    index.close();
    sandbox.restore();
  }
});

test('Event bus prunes rotated archives older than seven days on startup', async () => {
  const sandbox = createStateSandbox('nexus-event-maintenance');
  const active = path.join(sandbox.root, 'events.jsonl');
  const oldArchive = `${active}.1`;
  const freshArchive = `${active}.2`;

  try {
    fs.writeFileSync(active, '', 'utf8');
    fs.writeFileSync(oldArchive, '{"id":"old","type":"dashboard.action","timestamp":1,"data":{"action":"old","status":"ok"}}\n', 'utf8');
    fs.writeFileSync(freshArchive, '{"id":"fresh","type":"dashboard.action","timestamp":2,"data":{"action":"fresh","status":"ok"}}\n', 'utf8');
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fs.utimesSync(oldArchive, eightDaysAgo, eightDaysAgo);
    fs.utimesSync(freshArchive, oneDayAgo, oneDayAgo);

    const moduleHref = `${pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/engines/event-bus.ts')).href}?startup=${Date.now()}`;
    await import(moduleHref);

    equal(fs.existsSync(oldArchive), false);
    equal(fs.existsSync(freshArchive), true);
  } finally {
    sandbox.restore();
  }
});

test('KnowledgeFabricEngine keeps only the latest twenty session snapshots per runtime', () => {
  const sandbox = createStateSandbox('nexus-knowledge-maintenance');
  const engine = new KnowledgeFabricEngine({
    repoRoot: sandbox.root,
    stateRoot: sandbox.root,
  });
  const runtimeId = 'runtime-prune';

  try {
    for (let index = 0; index < 25; index += 1) {
      engine.compose({
        runtimeId,
        sessionId: `session-${index}`,
        task: 'prune knowledge fabric snapshots',
        candidateFiles: [],
        memoryMatches: [],
      });
    }

    const runtimeDir = path.join(sandbox.root, 'knowledge-fabric', runtimeId);
    const jsonFiles = fs.readdirSync(runtimeDir).filter((entry) => entry.endsWith('.json'));

    equal(jsonFiles.length, 21);
    ok(jsonFiles.includes('latest.json'));
    equal(jsonFiles.includes('session-0.json'), false);
    equal(jsonFiles.includes('session-4.json'), false);
    equal(jsonFiles.includes('session-24.json'), true);
  } finally {
    sandbox.restore();
  }
});
