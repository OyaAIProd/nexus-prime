import { nexusEventBus } from './event-bus.js';

export interface CompactionSentinelOptions {
  budgetTokens?: number;
  checkIntervalMs?: number;
}

export class CompactionSentinel {
  private budgetTokens: number;
  private checkIntervalMs: number;
  private timer?: NodeJS.Timeout;
  private currentTokens: number = 0;
  private storeRate: number = 0;
  private startTime: number;
  private lastStoreCount: number = 0;
  private currentStoreCount: number = 0;
  private unsubscribeStore?: () => void;

  constructor(options: CompactionSentinelOptions = {}) {
    this.budgetTokens = options.budgetTokens ?? 100000;
    this.checkIntervalMs = options.checkIntervalMs ?? 10000;
    this.startTime = Date.now();
  }

  public start(): void {
    if (this.timer) return;

    this.startTime = Date.now();
    this.unsubscribeStore = nexusEventBus.on('memory.store', () => {
      this.currentStoreCount++;
    });

    this.timer = setInterval(() => {
      this.checkTriggers();
    }, this.checkIntervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.unsubscribeStore?.();
    this.unsubscribeStore = undefined;
    this.currentStoreCount = 0;
    this.lastStoreCount = 0;
  }

  public updateTokens(tokens: number): void {
    this.currentTokens = tokens;
  }

  private checkTriggers(): void {
    const sessionAgeMinutes = (Date.now() - this.startTime) / 60000;
    
    this.storeRate = this.currentStoreCount - this.lastStoreCount;
    this.lastStoreCount = this.currentStoreCount;

    const isNearBudget = this.currentTokens > this.budgetTokens * 0.9;
    const isRapidStoring = this.storeRate > 10;
    let reason = '';

    if (isNearBudget) {
      reason = 'Token count nearing context budget';
    } else if (isRapidStoring) {
      reason = 'Rapid memory burst detected';
    }

    if (reason) {
      nexusEventBus.emit('memory.pre-compaction', {
        tokensRemaining: this.budgetTokens - this.currentTokens,
        reason,
        sessionAgeMinutes,
      });
    }
  }
}
