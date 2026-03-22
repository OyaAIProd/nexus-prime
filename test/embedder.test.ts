import test from 'node:test';
import { equal, ok, throws } from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { Embedder, HyperbolicMath } from '../src/engines/embedder.js';

function createDbPath(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(root, 'embedder.db');
}

test('HyperbolicMath.mobiusAdd is explicitly tombstoned', () => {
  throws(
    () => HyperbolicMath.mobiusAdd([0.1, 0.2], [0.3, 0.4]),
    /not implemented/i,
  );
});

test('Embedder preserves vocabulary across batches with persistent stats', () => {
  const dbPath = createDbPath('nexus-embedder-persistent');
  const db = new Database(dbPath);
  const embedder = new Embedder(db);

  embedder.fitVocabulary(Array.from({ length: 100 }, (_, index) => `legacytoken cluster ${index}`));
  embedder.fitVocabulary(Array.from({ length: 10 }, (_, index) => `novelterm${index} fresh signal ${index}`));

  const vocabulary = (embedder as any).vocabulary as Map<string, number>;
  ok(vocabulary.has('legacytoken'));

  const vector = embedder.localEmbed('legacytoken cluster');
  ok(vector.some((value) => value > 0), 'expected the legacy term to remain embeddable');

  const docCount = db.prepare(
    "SELECT value FROM vocabulary_meta WHERE key = 'doc_count'",
  ).get() as { value: string };
  equal(Number.parseInt(docCount.value, 10), 110);

  const stats = db.prepare(
    'SELECT df FROM vocabulary_stats WHERE term = ?',
  ).get('legacytoken') as { df: number };
  equal(stats.df, 100);

  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});
