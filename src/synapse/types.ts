import type BetterSqlite3 from 'better-sqlite3';
import type { OrchestratorEngine } from '../engines/orchestrator.js';
import type { MemoryEngine } from '../engines/memory.js';
import type { SessionDNAManager } from '../engines/session-dna.js';
import type { SkillRuntime } from '../engines/skill-runtime.js';
import type { KnowledgeFabricEngine } from '../engines/knowledge-fabric.js';
import type { ExecutionRun } from '../phantom/runtime.js';

export type SynapseDb = BetterSqlite3.Database;

export type OperativeState =
  | 'IDLE'
  | 'ACTIVE'
  | 'CHECKOUT'
  | 'STANDDOWN'
  | 'SUSPENDED'
  | 'DONE';

export type MissionComplexity = 'read' | 'orchestrate' | 'mutate';
export type OperativeHealthState = 'WORKING' | 'STALLED' | 'ZOMBIE' | 'BLOCKED' | 'IDLE';

export interface Operative {
  id: string;
  name: string;
  skillId: string | null;
  specialistId: string | null;
  state: OperativeState;
  suspendReason: 'budget_exceeded' | 'compaction' | 'manual' | null;
  healthState: OperativeHealthState;
  missionId: string | null;
  strikeTeamId: string | null;
  budgetCapUsd: number;
  spentUsd: number;
  commendationScore: number;
  sortieIntervalMs: number;
  lastSortieAt: string | null;
  createdAt: string;
}

export interface StrikeTeam {
  id: string;
  mandateText: string;
  operativeIds: string[];
  missionIds: string[];
  blueprintId: string | null;
  status: 'deploying' | 'active' | 'converging' | 'done' | 'standdown';
  createdAt: string;
}

export interface Mission {
  id: string;
  parentMissionId: string | null;
  strikeTeamId: string | null;
  title: string;
  complexity: MissionComplexity;
  status: 'open' | 'active' | 'done' | 'blocked' | 'failed';
  assignedOperativeId: string | null;
  requiresApprovalGate: boolean;
  createdAt: string;
}

export interface Sortie {
  id: string;
  operativeId: string;
  missionId: string | null;
  status: 'running' | 'completed' | 'failed' | 'interrupted_compaction' | 'deferred';
  tokensUsed: number;
  costUsd: number;
  fieldReportId: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface FieldReport {
  id: string;
  sortieId: string;
  operativeId: string;
  strikeTeamId: string | null;
  missionTitle: string;
  findings: string;
  filesChanged: string[];
  blockersEncountered: string;
  nextRecommendedAction: string;
  tokensUsed: number;
  costUsd: number;
  ledgerPath: string | null;
  status: 'completed' | 'blocked' | 'failed';
  completedAt: string;
}

export interface ApprovalRequest {
  id: string;
  missionId: string | null;
  operativeId: string;
  action: string;
  description: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedAt: string | null;
  createdAt: string;
}

export interface EchoResult {
  found: boolean;
  summary: string;
  predecessorSortieIds: string[];
  priorBlockers: string[];
}

export interface MandateSignals {
  domains: string[];
  complexity: MissionComplexity;
  subGoalHints: string[];
}

export interface SynapseProviders {
  repoRoot: string;
  orchestrator: OrchestratorEngine;
  memory: MemoryEngine;
  sessionDNA: SessionDNAManager;
  skillRuntime: SkillRuntime;
  knowledgeFabric: KnowledgeFabricEngine;
  claimWorkItem?: (workItemId: string, operativeId: string) => Promise<unknown | null>;
  completeWorkItem?: (workItemId: string, operativeId: string, status: 'done' | 'failed' | 'blocked') => Promise<unknown>;
}

export interface SynapseRuntime {
  db: SynapseDb;
  providers: SynapseProviders;
  executeMandatePipeline(mandateText: string, opts?: { budgetUsd?: number; maxOperatives?: number }): Promise<StrikeTeam>;
  runSortie(operativeId: string): Promise<Sortie>;
  requestApproval(input: { operativeId: string; missionId?: string | null; action: string; description: string }): ApprovalRequest;
  resolveApproval(approvalId: string, decision: 'approved' | 'rejected'): ApprovalRequest | null;
  noteMissionProgress(operativeId: string, missionId: string | null, note: string): string;
  submitFieldReport(report: FieldReport): FieldReport;
  getStrikeTeamStatus(strikeTeamId?: string): StrikeTeam[] | StrikeTeam | null;
  getOperativeHealth(operativeId?: string): Operative[] | Operative | null;
  queryEcho(input: { missionId?: string | null; missionTitle: string; currentOperativeId: string }): Promise<EchoResult>;
  getPendingApprovals(): ApprovalRequest[];
  stop(): void;
}

export interface SortieExecutionContext {
  operative: Operative;
  mission: Mission | null;
  execution: ExecutionRun;
}
