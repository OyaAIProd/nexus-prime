import assert from 'assert';
import { sendRelay } from '../relay/messenger.js';
import { getRelayInbox } from '../relay/inbox.js';
import { createArchitectsDb, createArchitectsProviders } from './helpers.js';

export async function run() {
  const { db, root } = createArchitectsDb();
  const providers = createArchitectsProviders(root);
  const knownTargets = new Set(['operative-2']);

  const message = await sendRelay(db, providers, knownTargets, {
    fromOperativeId: 'operative-1',
    toId: 'operative-2',
    target: 'operative',
    subject: 'BLOCKER',
    body: 'Need migration context',
  });

  assert.strictEqual(message.toOperativeId, 'operative-2', 'relay should persist addressed messages');
  const inbox = getRelayInbox(db, { operativeId: 'operative-2', markRead: true });
  assert.strictEqual(inbox.length, 1, 'relay inbox should surface persisted messages');
  assert.ok(inbox[0].readAt === null, 'inbox view should return the pre-read snapshot');

  await assert.rejects(() => sendRelay(db, providers, knownTargets, {
    fromOperativeId: 'operative-1',
    toId: 'missing',
    target: 'operative',
    subject: 'PING',
    body: 'hello',
  }), /Unknown relay target operative/, 'relay should reject unknown operative targets');

  db.close();
}
