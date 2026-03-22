import { randomUUID } from 'crypto';
import { nexusEventBus } from '../../engines/event-bus.js';
import { ArchitectsConfig } from '../config.js';
import type { ArchitectsDb } from '../types.js';

export class DispatchGovernor {
  private queue: Array<{ operativeId: string; workItemId: string }> = [];
  private active = 0;

  constructor(private db: ArchitectsDb) {}

  get limit(): number {
    return ArchitectsConfig.maxConcurrent;
  }

  get throttled(): boolean {
    return this.limit > 0;
  }

  dispatch(operativeId: string, workItemId: string): void {
    if (!this.throttled || this.active < this.limit) {
      this.active += 1;
      this.db.prepare(`
        INSERT INTO architects_dispatch_queue (id, operative_id, work_item_id, scheduled_at, dispatched_at, status)
        VALUES (?, ?, ?, datetime('now'), datetime('now'), 'dispatched')
      `).run(randomUUID(), operativeId, workItemId);
      nexusEventBus.emit('architects.dispatch.go', { operativeId, workItemId });
      return;
    }
    this.queue.push({ operativeId, workItemId });
    this.db.prepare(`
      INSERT INTO architects_dispatch_queue (id, operative_id, work_item_id, scheduled_at, status)
      VALUES (?, ?, ?, datetime('now'), 'queued')
    `).run(randomUUID(), operativeId, workItemId);
    nexusEventBus.emit('architects.dispatch.queued', { operativeId, workItemId, depth: this.queue.length });
  }

  complete(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (!next) return;
    this.active += 1;
    nexusEventBus.emit('architects.dispatch.go', next);
  }

  getStatus() {
    return {
      throttled: this.throttled,
      active: this.active,
      queueDepth: this.queue.length,
      limit: this.limit,
    };
  }
}
