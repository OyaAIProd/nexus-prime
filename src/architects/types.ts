import type BetterSqlite3 from 'better-sqlite3';
import type { WorkflowRuntime } from '../engines/workflow-runtime.js';
import type { HookRuntime } from '../engines/hook-runtime.js';
import type { PersistentWorkLedger } from '../engines/work-ledger.js';
import type { NexusNetRelay } from '../engines/nexusnet-relay.js';

export type ArchitectsDb = BetterSqlite3.Database;

export type WorkItemStatus = 'todo' | 'claimed' | 'in_progress' | 'done' | 'failed' | 'blocked';
export type BlueprintStatus = 'draft' | 'active' | 'converging' | 'done' | 'archived';

export interface Blueprint {
  id: string;
  strikeTeamId: string | null;
  title: string;
  workflowId: string | null;
  status: BlueprintStatus;
  variables: Record<string, string>;
  worklistId: string | null;
  createdAt: string;
}

export interface Worklist {
  id: string;
  blueprintId: string;
  title: string;
  createdAt: string;
}

export interface WorkItem {
  id: string;
  worklistId: string;
  title: string;
  status: WorkItemStatus;
  dependsOn: string[];
  assignedOperativeId: string | null;
  constructionLockId: string | null;
  branch: string | null;
  mergedAt: string | null;
  createdAt: string;
}

export interface ConstructionLock {
  id: string;
  workItemId: string;
  operativeId: string;
  acquiredAt: string;
  releasedAt: string | null;
  hookRef: string | null;
}

export interface RelayMessage {
  id: string;
  fromOperativeId: string;
  toOperativeId: string | null;
  strikeTeamId: string | null;
  subject: string;
  body: string;
  sentAt: string;
  readAt: string | null;
  priority: 'normal' | 'urgent';
}

export interface ConvergenceRun {
  id: string;
  worklistId: string;
  strategy: 'sequential' | 'bisecting';
  workItemIds: string[];
  status: 'running' | 'merged' | 'failed' | 'bisecting' | 'deferred';
  failedItemId: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface SentinelReport {
  strikeTeamId: string;
  operativeReports: Array<{
    operativeId: string;
    state: 'WORKING' | 'STALLED' | 'ZOMBIE' | 'IDLE';
    wtHealthy: boolean;
    lastSortieAt: string | null;
  }>;
  overallHealth: 'healthy' | 'degraded' | 'critical';
  stalledCount: number;
  zombieCount: number;
  generatedAt: string;
}

export interface ArchitectsProviders {
  repoRoot: string;
  workflowRuntime: WorkflowRuntime;
  hookRuntime: HookRuntime;
  ledger: PersistentWorkLedger;
  relay: NexusNetRelay;
}

export interface ArchitectsRuntime {
  db: ArchitectsDb;
  providers: ArchitectsProviders;
  instantiateBlueprint(input: { title: string; workflowId: string; variables?: Record<string, string>; strikeTeamId?: string | null }): { blueprint: Blueprint; worklist: Worklist; items: WorkItem[] };
  getWorklist(worklistId: string): { worklist: Worklist | null; items: WorkItem[] };
  getWorklistForStrikeTeam(strikeTeamId: string): string | null;
  claimWorkItem(workItemId: string, operativeId: string): Promise<ConstructionLock | null>;
  completeWorkItem(workItemId: string, operativeId: string, status: WorkItemStatus, branch?: string | null): Promise<WorkItem | null>;
  sendRelay(input: { fromOperativeId: string; toId: string; target: 'operative' | 'striketeam' | 'ward'; subject: string; body: string; priority?: 'normal' | 'urgent' }): Promise<RelayMessage>;
  getRelayInbox(input?: { operativeId?: string; strikeTeamId?: string; markRead?: boolean }): RelayMessage[];
  getSentinelReport(strikeTeamId: string): Promise<SentinelReport>;
  runConvergenceQueue(worklistId: string): Promise<ConvergenceRun>;
  getDispatchStatus(): { throttled: boolean; active: number; queueDepth: number; limit: number };
  getWardEscalations(): Array<{ strikeTeamId: string; consecutiveCriticalPatrols: number; message: string; report?: SentinelReport }>;
  stop(): void;
}
