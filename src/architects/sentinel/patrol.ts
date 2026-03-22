import { doctorGitWorktrees } from '../../engines/worktree-health.js';
import { nexusEventBus } from '../../engines/event-bus.js';
import { ArchitectsConfig } from '../config.js';
import type { ArchitectsDb, SentinelReport } from '../types.js';

export class ArchitectsSentinel {
  private timer?: NodeJS.Timeout;

  constructor(
    private db: ArchitectsDb,
    private strikeTeamId: string,
    private repoRoot: string,
    private operativeActivity: Map<string, { strikeTeamId: string | null; lastSortieAt: string | null }>,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.patrol();
    }, ArchitectsConfig.sentinelPatrolMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async patrol(): Promise<SentinelReport> {
    const worktree = await doctorGitWorktrees(this.repoRoot);
    const now = Date.now();
    const operatives = [...this.operativeActivity.entries()]
      .filter(([, activity]) => activity.strikeTeamId === this.strikeTeamId);

    let stalledCount = 0;
    let zombieCount = 0;
    const operativeReports = operatives.map(([operativeId, activity]) => {
      const ms = activity.lastSortieAt ? now - new Date(activity.lastSortieAt).getTime() : Number.POSITIVE_INFINITY;
      const state: 'WORKING' | 'STALLED' | 'ZOMBIE' | 'IDLE' =
        !activity.lastSortieAt ? 'IDLE' :
        ms > 15 * 60_000 ? 'ZOMBIE' :
        ms > 5 * 60_000 ? 'STALLED' :
        'WORKING';
      if (state === 'ZOMBIE') {
        zombieCount += 1;
        nexusEventBus.emit('architects.sentinel.zombie', { operativeId, strikeTeamId: this.strikeTeamId });
      } else if (state === 'STALLED') {
        stalledCount += 1;
        nexusEventBus.emit('architects.sentinel.stall', { operativeId, strikeTeamId: this.strikeTeamId });
      }
      return {
        operativeId,
        state,
        wtHealthy: worktree.overall === 'healthy',
        lastSortieAt: activity.lastSortieAt ?? null,
      };
    });

    const report: SentinelReport = {
      strikeTeamId: this.strikeTeamId,
      operativeReports,
      overallHealth: zombieCount > 0 ? 'critical' : stalledCount > 0 ? 'degraded' : 'healthy',
      stalledCount,
      zombieCount,
      generatedAt: new Date().toISOString(),
    };
    nexusEventBus.emit('architects.sentinel.patrol', report);
    return report;
  }
}
