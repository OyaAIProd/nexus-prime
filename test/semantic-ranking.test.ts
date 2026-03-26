import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Embedder } from '../src/engines/embedder.js';
import { computeSemanticScore } from '../src/engines/semantic-ranking.js';
import { RagCollectionStore } from '../src/engines/rag-collections.js';
import { ContextAssembler } from '../src/engines/context-assembler.js';

test('computeSemanticScore exposes stable breakdowns and favors aligned candidates', () => {
  const embedder = new Embedder();
  embedder.fitVocabulary([
    'authentication oauth login failure',
    'dashboard theme palette',
  ]);

  const query = 'oauth login failure';
  const queryVector = embedder.embedSync(query);
  const aligned = computeSemanticScore({
    query,
    queryVector,
    candidateText: 'authentication oauth login failure',
    candidateVector: embedder.embedSync('authentication oauth login failure'),
    lexicalTexts: ['authentication oauth login failure'],
    embedder,
  });
  const unrelated = computeSemanticScore({
    query,
    queryVector,
    candidateText: 'dashboard theme palette',
    candidateVector: embedder.embedSync('dashboard theme palette'),
    lexicalTexts: ['dashboard theme palette'],
    embedder,
  });

  ok(aligned.final > unrelated.final);
  ok(aligned.semantic >= aligned.lexical);
  ok(aligned.final <= 1 && aligned.final >= 0);
});

test('RAG retrieval and ContextAssembler expose score breakdowns', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-semantic-ranking-'));
  const sourceFile = path.join(root, 'auth.ts');
  fs.writeFileSync(sourceFile, 'export const authFailure = "oauth login failure";\n', 'utf8');

  const store = new RagCollectionStore(root);
  const collection = store.createCollection({
    name: 'Semantic ranking fixture',
    description: 'Exercise shared semantic scoring',
  });
  await store.ingestCollection(collection.collectionId, [
    { text: 'OAuth login failure requires auth callback repair.', label: 'auth' },
    { text: 'Dashboard theme colors updated for the design system.', label: 'theme' },
  ]);

  const hits = store.retrieve('oauth login failure', { limit: 2 });
  ok(hits.length >= 1);
  ok(hits[0].scoreBreakdown);
  equal(hits[0].score, hits[0].scoreBreakdown?.final);

  const assembler = new ContextAssembler();
  const assembly = assembler.assemble('oauth login failure', [
    {
      source: sourceFile,
      content: 'OAuth login failure requires auth callback repair.',
      tokens: 24,
      quality: 0.2,
      label: 'authFailure',
      startLine: 1,
      endLine: 1,
    },
    {
      source: sourceFile,
      content: 'Dashboard theme colors updated for the design system.',
      tokens: 24,
      quality: 0.2,
      label: 'themeUpdate',
      startLine: 2,
      endLine: 2,
    },
  ], 200);

  ok(assembly.selected.length >= 1);
  ok(assembly.selected[0].scoreBreakdown);
  ok((assembly.selected[0].scoreBreakdown?.relevance.final ?? 0) > 0);

  fs.rmSync(root, { recursive: true, force: true });
});
