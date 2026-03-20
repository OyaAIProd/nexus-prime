import { MemoryEngine } from './memory.js';

export interface MemoryBackgroundWorkerOptions {
  optimizationIntervalMs?: number;
}

export class MemoryBackgroundWorker {
  private memory: MemoryEngine;
  private optimizationIntervalMs: number;
  private timer?: NodeJS.Timeout;

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
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private optimize(): void {
    try {
      this.memory.maintenanceCycle();
    } catch (err) {
      console.error('[MemoryBackgroundWorker] Error during maintenance cycle:', err);
    }
  }
}
