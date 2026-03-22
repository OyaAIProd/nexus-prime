import assert from 'assert';
import { instantiateBlueprint } from '../blueprints/instantiate.js';
import { createArchitectsDb, createArchitectsProviders } from './helpers.js';

export async function run() {
  const { db, root } = createArchitectsDb();
  const providers = createArchitectsProviders(root);

  const result = instantiateBlueprint(db, providers, {
    title: 'Auth rollout',
    workflowId: 'wf-1',
    variables: { module: 'auth' },
    strikeTeamId: 'team-1',
  });

  assert.strictEqual(result.items.length, 2, 'blueprint instantiation should create work items from workflow steps');
  assert.ok(result.items[0].title.includes('auth'), 'workflow variables should interpolate into work item titles');

  assert.throws(() => instantiateBlueprint(db, {
    ...providers,
    workflowRuntime: { getArtifact: () => null, findByName: () => null },
  } as any, {
    title: 'Broken rollout',
    workflowId: 'missing',
  }), /Unknown workflowId/, 'unknown workflow ids should fail explicitly');

  db.close();
}
