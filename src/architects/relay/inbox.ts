import { nexusEventBus } from '../../engines/event-bus.js';
import { getRelayInbox as readRelayInbox } from '../worklist/crud.js';
import type { ArchitectsDb, RelayMessage } from '../types.js';

export function getRelayInbox(db: ArchitectsDb, input: { operativeId?: string; strikeTeamId?: string; markRead?: boolean }): RelayMessage[] {
  const messages = readRelayInbox(db, input);
  if (input.markRead && input.operativeId) {
    messages.forEach((message) => {
      nexusEventBus.emit('architects.relay.read', {
        messageId: message.id,
        byOperativeId: input.operativeId!,
      });
    });
  }
  return messages;
}
