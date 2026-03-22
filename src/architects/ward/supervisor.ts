import { nexusEventBus } from '../../engines/event-bus.js';
import { ArchitectsConfig } from '../config.js';
import { ArchitectsSentinel } from '../sentinel/patrol.js';
import type { ArchitectsDb, SentinelReport } from '../types.js';

export class ArchitectsWard {
  private sentinels = new Map<string, ArchitectsSentinel>();
  private criticalStreak = new Map<string, number>();
  private escalations: Array<{ strikeTeamId: string; consecutiveCriticalPatrols: number; message: string; report?: SentinelReport }> = [];
  private timer?: NodeJS.Timeout;

  constructor(
    private db: ArchitectsDb,
    private repoRoot: string,
    private operativeActivity: Map<string, { strikeTeamId: string | null; lastSortieAt: string | null }>,
  ) {}

  registerStrikeTeam(strikeTeamId: string): void {
    if (this.sentinels.has(strikeTeamId)) return;
    const sentinel = new ArchitectsSentinel(this.db, strikeTeamId, this.repoRoot, this.operativeActivity);
    this.sentinels.set(strikeTeamId, sentinel);
    sentinel.start();
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.supervise();
    }, ArchitectsConfig.wardPatrolMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.sentinels.forEach((sentinel) => sentinel.stop());
  }

  getEscalations() {
    return this.escalations.slice();
  }

  async supervise(): Promise<void> {
    for (const [strikeTeamId, sentinel] of this.sentinels) {
      const report = await sentinel.patrol();
      const streak = report.overallHealth === 'critical'
        ? (this.criticalStreak.get(strikeTeamId) ?? 0) + 1
        : 0;
      this.criticalStreak.set(strikeTeamId, streak);
      if (streak >= 2) {
        const escalation = {
          strikeTeamId,
          consecutiveCriticalPatrols: streak,
          message: `Strike Team ${strikeTeamId} critical for ${streak} patrols`,
          report,
        };
        this.escalations.push(escalation);
        nexusEventBus.emit('architects.ward.escalation', escalation);
        this.criticalStreak.set(strikeTeamId, 0);
      }
    }
    nexusEventBus.emit('architects.ward.patrol', { teamsChecked: this.sentinels.size });
  }
}
