import { MemoryEngine } from './memory.js';
import { nexusEventBus } from './event-bus.js';

export interface MemoryBackgroundWorkerOptions {
  optimizationIntervalMs?: number;
}

export class MemoryBackgroundWorker {
  private memory: MemoryEngine;
  private optimizationIntervalMs: number;
  private timer?: NodeJS.Timeout;
  private healthTick?: NodeJS.Timeout;

  constructor(memory: MemoryEngine, options: MemoryBackgroundWorkerOptions = {}) {
    this.memory = memory;
    this.optimizationIntervalMs = options.optimizationIntervalMs ?? 60000; // default 1 minute
  }

  public start(): void {
    if (this.timer) return;
    
    this.timer = setInterval(() => {
      this.optimize();
    }, this.optimizationIntervalMs);
    
    // Unref allows the process to exit if this is the only active timer
    if (this.timer.unref) {
      this.timer.unref();
    }

    this.startHealthTick();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.healthTick) {
      clearInterval(this.healthTick);
      this.healthTick = undefined;
    }
  }

  private optimize(): void {
    try {
      this.memory.maintenanceCycle();
    } catch (err) {
      console.error('[MemoryBackgroundWorker] Error during maintenance cycle:', err);
    }
  }

  private startHealthTick(): void {
    if (this.healthTick) return;

    this.healthTick = setInterval(() => {
      try {
        const counts = this.memory.db.prepare(`
          SELECT state, COUNT(*) as c
          FROM memories
          GROUP BY state
        `).all() as Array<{ state: string; c: number }>;
        nexusEventBus.emit('memory.health.tick', {
          counts,
          ts: Date.now(),
        });
        this.memory.db.prepare(`
          UPDATE memories
          SET state = 'quarantined'
          WHERE state = 'active'
            AND entropy > 0.85
            AND access_count < 2
        `).run();
      } catch (err) {
        console.error('[MemoryBackgroundWorker] Error during health tick:', err);
      }
    }, 60_000);
    this.healthTick.unref();
  }
}
