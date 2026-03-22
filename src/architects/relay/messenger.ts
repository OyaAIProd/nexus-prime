import { randomUUID } from 'crypto';
import { nexusEventBus } from '../../engines/event-bus.js';
import { insertRelayMessage, getRelayMessage } from '../worklist/crud.js';
import type { ArchitectsDb, ArchitectsProviders, RelayMessage } from '../types.js';

export async function sendRelay(
  db: ArchitectsDb,
  providers: ArchitectsProviders,
  knownTargets: Set<string>,
  input: { fromOperativeId: string; toId: string; target: 'operative' | 'striketeam' | 'ward'; subject: string; body: string; priority?: 'normal' | 'urgent' },
): Promise<RelayMessage> {
  if (input.target === 'operative' && !knownTargets.has(input.toId)) {
    throw new Error(`[Architects] Unknown relay target operative ${input.toId}`);
  }
  const id = randomUUID();
  const message = insertRelayMessage(db, {
    id,
    fromOperativeId: input.fromOperativeId,
    toOperativeId: input.target === 'operative' ? input.toId : null,
    strikeTeamId: input.target === 'striketeam' ? input.toId : null,
    subject: input.subject,
    body: input.body,
    priority: input.priority ?? 'normal',
  });

  await providers.relay.publish('query', {
    content: JSON.stringify({ type: 'relay', target: input.target, toId: input.toId, subject: input.subject }),
    tags: ['#architects', '#relay', `#target:${input.target}`],
  }).catch(() => undefined);

  nexusEventBus.emit('architects.relay.sent', {
    messageId: message.id,
    from: input.fromOperativeId,
    target: input.target,
    toId: input.toId,
    subject: input.subject,
  });
  return getRelayMessage(db, message.id)!;
}
