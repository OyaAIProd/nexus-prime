/**
 * Autonomy Orchestrator
 *
 * Mandatory control plane for high-level Nexus Prime execution.
 * Raw prompts flow through this layer before the runtime executes work.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { MemoryEngine } from './memory.js';
import { nexusEventBus } from './event-bus.js';
import { CompactionSentinel } from './compaction-sentinel.js';
import { MemoryBackgroundWorker } from './memory-background.js';
import { RepoTreeGenerator, type RepoTreeNode } from './repo-tree.js';
import { createSkillRuntime, type SkillRuntime } from './skill-runtime.js';
import { SkillLearnerEngine } from './skill-learner.js';
import { nxl, type AgentArchetype } from './nxl-interpreter.js';
import { TokenSupremacyEngine, type FileRef, formatReadingPlan, type ReadingPlan } from './token-supremacy.js';
import { getSharedSummarizer } from './self-summarizer.js';
import { resolveNexusStateDir } from './runtime-registry.js';
import { LifecyclePolicy } from './lifecycle-policy.js';
import type {
  RuntimeArtifactSelectionAudit,
  RuntimeArtifactOutcomeSnapshot,
  RuntimeCatalogHealthSnapshot,
  RuntimeRagUsageSummary,
  RuntimeRegistrySnapshot,
  RuntimeTaskGraphSnapshot,
  RuntimeOrchestrationSnapshot,
  RuntimePrimaryClientSnapshot,
  RuntimeSourceAwareTokenBudgetSnapshot,
  RuntimeTokenSummarySnapshot,
  RuntimeWorkerPlanSnapshot,
} from './runtime-registry.js';
import { SessionDNAManager, type SessionDNA } from './session-dna.js';
import type { ClientRecord, ClientRegistry } from './client-registry.js';
import {
  DEFAULT_REQUIRED_SEQUENCE,
  InstructionGateway,
  createExecutionLedger,
  markExecutionLedgerStep,
  type GovernanceSnapshot,
} from './instruction-gateway.js';
import { KnowledgeFabricEngine, type KnowledgeFabricBundle } from './knowledge-fabric.js';
import { readBootstrapManifest, type BootstrapManifestStatus } from './client-bootstrap.js';
import {
  GhostPass,
  type GhostReport,
  createSubAgentRuntime,
  type ExecutionRun,
  type ExecutionTask,
  type SubAgentRuntime,
} from '../phantom/index.js';

export type AgentType = 'researcher' | 'coder' | 'planner' | 'executor' | 'reviewer' | 'architect' | 'ux-validator';

export interface Agent {
  id: string;
  type: AgentType | string;
  task: string;
  state: 'pending' | 'running' | 'complete' | 'failed';
  result?: string;
  archetype?: AgentArchetype;
}

export interface Task {
  id: string;
  description: string;
  complexity: number;
  subtasks: string[];
}

export interface AutonomyIntent {
  taskType: 'bugfix' | 'feature' | 'release' | 'review' | 'research' | 'refactor' | 'ops' | 'pm' | 'test' | 'frontend' | 'backend' | 'ai' | 'marketing' | 'sales' | 'data';
  secondaryType?: string;
  intentScores?: Record<string, number>;
  riskClass: 'low' | 'medium' | 'high';
  complexity: number;
}

export interface SessionAutonomyState {
  runtimeId: string;
  sessionId: string;
  startedAt: number;
  updatedAt: number;
  lastPrompt: string;
  objectiveHistory: string[];
  phases: string[];
  mode: RuntimeOrchestrationSnapshot['mode'];
  repeatedFailures: number;
  continuationDepth: number;
  intent: AutonomyIntent;
  selectedCrew?: string;
  selectedSpecialists: string[];
  selectedSkills: string[];
  selectedWorkflows: string[];
  selectedHooks: string[];
  selectedAutomations: string[];
  lastMemoryMatches: string[];
  latestSessionDNA?: {
    sessionId: string;
    timestamp: number;
    handoverScore: number;
  };
  lastRunId?: string;
  primaryClient?: RuntimePrimaryClientSnapshot;
  tokenSummary?: RuntimeTokenSummarySnapshot;
  artifactOutcomeHistory?: Record<string, number>;
}

export interface SessionBootstrapResult {
  client?: RuntimePrimaryClientSnapshot;
  memoryRecall: {
    count: number;
    matches: string[];
  };
  memoryStats: ReturnType<MemoryEngine['getStats']>;
  recommendedNextStep: 'nexus_orchestrate' | 'nexus_plan_execution';
  recommendedExecutionMode: RuntimeOrchestrationSnapshot['mode'];
  shortlist: {
    crews: string[];
    specialists: string[];
    skills: string[];
    workflows: string[];
    hooks: string[];
    automations: string[];
  };
  tokenOptimization: {
    required: boolean;
    reason: string;
    candidateFiles: string[];
    autoApplied?: boolean;
    plan?: string;
    planMetrics?: {
      files: number;
      savings: number;
      compressedTokens: number;
      originalTokens: number;
      pct?: number;
    };
    policy?: {
      feature: string;
      enabled: boolean;
      reason: string;
      contextHash: string;
    };
  };
  sessionSummaryBootstrap?: {
    summary: string;
    summaryTokens: number;
    originalTokens: number;
    savedTokens: number;
  };
  reviewGates: string[];
  catalogHealth: RuntimeCatalogHealthSnapshot;
  sourceMixRecommendation: {
    dominantSource: string;
    reasons: string[];
  };
  ragCandidateStatus: {
    attachedCollections: number;
    retrievedChunks: number;
    selectedChunks: number;
    droppedChunks: number;
    attachedNames: string[];
  };
  clientBootstrapStatus?: BootstrapManifestStatus;
  artifactSelectionAudit: RuntimeArtifactSelectionAudit;
  taskGraphPreview: RuntimeTaskGraphSnapshot;
  workerPlanPreview: RuntimeWorkerPlanSnapshot;
  knowledgeFabric: {
    summary: string;
    dominantSource: string;
    attachedCollections: string[];
    patternHits: string[];
    selectedFiles: string[];
    modelTiers: string[];
  };
  autoGhostPass?: {
    applied: boolean;
    riskAreas: string[];
    workerApproaches: number;
    estimatedTokens: number;
    policy: {
      feature: string;
      enabled: boolean;
      reason: string;
      contextHash: string;
    };
  };
  repoTree?: RepoTreeNode;
}

interface CatalogItem {
  id: string;
  name: string;
  body: string;
}

interface ResolvedSelections {
  crew?: string;
  specialists: string[];
  skills: string[];
  workflows: string[];
  hooks: string[];
  automations: string[];
  audit: RuntimeArtifactSelectionAudit;
}

interface PreparedExecution {
  intent: AutonomyIntent;
  phases: string[];
  primaryClient?: RuntimePrimaryClientSnapshot;
  bootstrapManifest: BootstrapManifestStatus;
  latestDNA?: ReturnType<typeof SessionDNAManager.loadLatest>;
  memoryMatches: string[];
  memoryStats: ReturnType<MemoryEngine['getStats']>;
  candidateFiles: string[];
  knowledgeFabric: KnowledgeFabricBundle;
  plannedFiles: string[];
  planner: Awaited<ReturnType<SubAgentRuntime['planExecution']>>;
  selections: ResolvedSelections;
  catalogHealth: RuntimeCatalogHealthSnapshot;
  tokenBudget: RuntimeSourceAwareTokenBudgetSnapshot;
  workerCount: number;
  mode: RuntimeOrchestrationSnapshot['mode'];
  taskGraph: RuntimeTaskGraphSnapshot;
  workerPlan: RuntimeWorkerPlanSnapshot;
  autoGhostPass?: GhostReport;
  autoGhostPassDecision?: {
    feature: string;
    enabled: boolean;
    reason: string;
    contextHash: string;
  };
}

interface OrchestratorOptions {
  memory?: MemoryEngine;
  runtime?: SubAgentRuntime;
  clientRegistry?: ClientRegistry;
  sessionDNA?: SessionDNAManager;
  repoRoot?: string;
}

const MAX_AUTONOMY_HISTORY = 24;
const MAX_DISCOVERED_FILES = 32;
const ABSOLUTE_SECONDARY_MIN = 0.3;
const DISCOVERY_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml']);
const DISCOVERY_IGNORES = new Set(['.git', 'node_modules', 'dist', 'coverage', '.next', '.playwright-cli', 'tmp']);

export class OrchestratorEngine {
  private agents: Map<string, Agent> = new Map();
  private memory: MemoryEngine;
  private agentCounter = 0;
  private runtime: SubAgentRuntime;
  private lastRun: ExecutionRun | null = null;
  private clientRegistry?: ClientRegistry;
  private sessionDNA?: SessionDNAManager;
  private repoRoot: string;
  private tokenEngine: TokenSupremacyEngine;
  private instructionGateway: InstructionGateway;
  private knowledgeFabric: KnowledgeFabricEngine;
  private sessionsDir: string;
  private sessionState: SessionAutonomyState;
  private flushInterval?: NodeJS.Timeout;
  private compactionSentinel?: CompactionSentinel;
  private memoryBackgroundWorker?: MemoryBackgroundWorker;
  private unsubscribePreCompaction?: () => void;
  private repoTreeGenerator: RepoTreeGenerator;
  private skillRuntime: SkillRuntime;
  private skillLearner: SkillLearnerEngine;
  private executionDedupeStore = new Map<string, { id: string; state: string; ts: number; promise?: Promise<ExecutionRun> }>();
  private circuitOpenUntil = 0;
  private consecutiveFailures = 0;
  private readonly CIRCUIT_THRESHOLD = 3;
  private readonly CIRCUIT_COOLDOWN_MS = 30_000;
  private lifecyclePolicy: LifecyclePolicy;

  constructor(options: OrchestratorOptions = {}) {
    this.memory = options.memory || new MemoryEngine();
    this.skillRuntime = createSkillRuntime(undefined, undefined, options.repoRoot ?? process.cwd());
    this.runtime = options.runtime || createSubAgentRuntime({
      repoRoot: options.repoRoot ?? process.cwd(),
      memory: this.memory,
      skillRuntime: this.skillRuntime,
    });
    this.clientRegistry = options.clientRegistry;
    this.sessionDNA = options.sessionDNA;
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.tokenEngine = new TokenSupremacyEngine();
    this.instructionGateway = new InstructionGateway(this.repoRoot);
    this.knowledgeFabric = new KnowledgeFabricEngine({
      repoRoot: this.repoRoot,
      memory: this.memory,
      tokenEngine: this.tokenEngine,
    });
    this.lifecyclePolicy = new LifecyclePolicy();
    this.sessionsDir = path.join(resolveNexusStateDir(), 'autonomy-sessions');
    try {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    } catch (err: any) {
      if (['EROFS', 'ENOENT', 'EACCES'].includes(err?.code)) {
        this.sessionsDir = path.join(os.tmpdir(), 'nexus-prime-sessions');
        fs.mkdirSync(this.sessionsDir, { recursive: true });
      } else {
        throw err;
      }
    }
    this.sessionState = this.loadSessionState();
    this.pruneStaleAutonomySessions();

    this.memoryBackgroundWorker = new MemoryBackgroundWorker(this.memory);
    this.repoTreeGenerator = new RepoTreeGenerator(this.repoRoot);
    this.skillLearner = new SkillLearnerEngine(this.skillRuntime, this.memory);
  }

  /**
   * Induces a specialized army of agents based on the prompt.
   * This remains a planning signal for runtime execution, not a direct executor.
   */
  public async induce(task: string): Promise<Agent[]> {
    const archetypes = nxl.induceArmy(task);
    const inductedAgents: Agent[] = [];

    for (const arch of archetypes) {
      const id = `agent_${++this.agentCounter}_${arch.name.toLowerCase().replace(/\s+/g, '_')}`;
      const agent: Agent = {
        id,
        type: arch.role,
        task,
        state: 'pending',
        archetype: arch,
      };
      this.agents.set(id, agent);
      inductedAgents.push(agent);
    }

    nexusEventBus.emit('nexusnet.sync', { newItemsCount: inductedAgents.length });
    return inductedAgents;
  }

  public decomposeTask(task: string): string[] {
    const normalized = task
      .split(/\n+/)
      .map((segment) => segment.trim())
      .filter(Boolean)
      .join(' ');

    const subtasks = normalized
      .split(/,| then | and then | after that | followed by | also /i)
      .map((segment) => segment.trim())
      .filter(Boolean);

    return subtasks.length > 0 ? subtasks : [task];
  }

  private shouldAutoGhostPass(task: string, candidateFiles: string[], phaseCount: number): boolean {
    if (candidateFiles.length < 3) return false;
    if (phaseCount >= 3) return true;
    return /(refactor|move|rename|restructure|migrate|extract|split|consolidate)/i.test(task);
  }

  private async autoGhostPass(task: string, files: string[]): Promise<GhostReport> {
    const ghost = new GhostPass(this.repoRoot);
    const refs = this.toFileRefs(files);
    return ghost.analyze(task, refs, Math.min(4, Math.max(2, Math.ceil(files.length / 2))));
  }

  private toFileRefs(files: string[]): FileRef[] {
    return files.map((candidate) => {
      const resolved = path.isAbsolute(candidate) ? candidate : path.join(this.repoRoot, candidate);
      try {
        const stat = fs.statSync(resolved);
        return {
          path: resolved,
          sizeBytes: stat.size,
          lastModified: stat.mtimeMs,
        };
      } catch {
        return {
          path: resolved,
          sizeBytes: 0,
        };
      }
    });
  }

  private async _prepareExecution(task: string, options: Partial<ExecutionTask> = {}): Promise<PreparedExecution> {
    const intent = this.classifyIntent(task);
    const phases = this.decomposeTask(task);
    const primaryClient = this.resolvePrimaryClient();
    const bootstrapManifest = readBootstrapManifest();
    const latestDNA = SessionDNAManager.loadLatest();
    const memoryMatchesFull = await this.memory.recallWithMetadata(task, 8, this.buildWorkspaceRecallFilters());
    const memoryMatches = memoryMatchesFull.map(m => m.content);
    const memoryStats = this.memory.getStats();
    const candidateFiles = options.files?.length
      ? options.files
      : this.discoverCandidateFiles(task, latestDNA);
    await this.knowledgeFabric.ensureBootstrapCollection({
      runtimeId: this.runtime.getRuntimeId(),
      sessionId: this.sessionState.sessionId,
      candidateFiles,
    });
    let knowledgeFabric: KnowledgeFabricBundle;
    try {
      const qualityMeta = memoryMatchesFull.map(m => ({ content: m.content, confidence: m.confidence, entropy: m.entropy, trust: m.trust }));
      const fileBoosts = this.memory.getFileBoosts(candidateFiles);
      knowledgeFabric = this.composeKnowledgeFabric(task, candidateFiles, memoryMatches, intent, qualityMeta, fileBoosts);
    } catch (error: any) {
      console.warn('[Orchestrator] Knowledge Fabric compose failed, retrying:', error?.message ?? error);
      try {
        const qualityMeta = memoryMatchesFull.map(m => ({ content: m.content, confidence: m.confidence, entropy: m.entropy, trust: m.trust }));
        const fileBoosts = this.memory.getFileBoosts(candidateFiles);
        knowledgeFabric = this.composeKnowledgeFabric(task, candidateFiles, memoryMatches, intent, qualityMeta, fileBoosts);
      } catch (retryError: any) {
        throw new Error(`[Orchestrator] Knowledge Fabric unavailable: ${retryError?.message ?? retryError}`);
      }
    }
    const plannedFiles = options.files?.length
      ? options.files
      : (knowledgeFabric.repo.selectedFiles.length > 0 ? knowledgeFabric.repo.selectedFiles : candidateFiles);
    const planner = await this.runtime.planExecution({
      goal: task,
      files: plannedFiles,
      skillNames: options.skillNames,
      workflowSelectors: options.workflowSelectors,
      crewSelectors: options.crewSelectors,
      specialistSelectors: options.specialistSelectors,
      workers: options.workers,
      optimizationProfile: options.optimizationProfile,
    });
    const selections = this.resolveSelections(task, intent, planner, knowledgeFabric, options);
    const catalogHealth = this.scanCatalogHealth(selections);
    const tokenBudget = this.toSourceAwareTokenBudget(knowledgeFabric, plannedFiles, 'knowledge-fabric-source-aware-budget');
    const workerCount = this.decideWorkers(
      options.workers,
      planner.swarmDecision.workers,
      phases.length,
      intent,
      this.sessionState.repeatedFailures,
      knowledgeFabric,
    );
    const mode = this.determineMode(intent, phases.length, workerCount);
    const taskGraph = this.buildTaskGraph(task, phases, intent);
    const workerPlan = this.buildWorkerPlan(workerCount, mode, taskGraph, knowledgeFabric);
    const autoGhostPassDecision = this.lifecyclePolicy.evaluate('autoGhostPass', {
      candidateFiles: candidateFiles.length,
      phaseCount: phases.length,
      taskPreview: shortLabel(task, 120),
    });
    let autoGhostPass: GhostReport | undefined;
    if (autoGhostPassDecision.enabled && this.shouldAutoGhostPass(task, candidateFiles, phases.length)) {
      try {
        autoGhostPass = await this.autoGhostPass(task, candidateFiles);
      } catch (error: any) {
        console.warn('[Orchestrator] Auto ghost-pass failed, continuing with manual fallback:', error?.message ?? error);
      }
    }

    return {
      intent,
      phases,
      primaryClient,
      bootstrapManifest,
      latestDNA,
      memoryMatches,
      memoryStats,
      candidateFiles,
      knowledgeFabric,
      plannedFiles,
      planner,
      selections,
      catalogHealth,
      tokenBudget,
      workerCount,
      mode,
      taskGraph,
      workerPlan,
      autoGhostPass,
      autoGhostPassDecision: {
        feature: autoGhostPassDecision.feature,
        enabled: autoGhostPassDecision.enabled,
        reason: autoGhostPassDecision.reason,
        contextHash: autoGhostPassDecision.contextHash,
      },
    };
  }

  private checkCircuit(): void {
    if (Date.now() >= this.circuitOpenUntil) {
      return;
    }
    const remainingMs = this.circuitOpenUntil - Date.now();
    nexusEventBus.emit('nexus.circuit-open', {
      remainingMs,
      consecutiveFailures: this.consecutiveFailures,
    });
    throw new Error(
      `Orchestration circuit open for ${Math.ceil(remainingMs / 1000)}s after ${this.consecutiveFailures} consecutive failures.`,
    );
  }

  private getRunFingerprint(sessionId: string, task: string, clientId: string): string {
    const key = `${sessionId}:${clientId}:${task.trim().toLowerCase().slice(0, 256)}`;
    let hash = 5381n;
    for (const char of key) {
      hash = (hash * 33n ^ BigInt(char.charCodeAt(0))) & 0xFFFFFFFFFFFFFFFFn;
    }
    return hash.toString(16);
  }

  private buildWorkspaceRecallFilters() {
    return {
      sessionId: this.sessionState.sessionId,
      repoId: this.getRepoScopedId('repo'),
      workspaceId: this.getRepoScopedId('workspace'),
      projectId: this.getRepoScopedId('project'),
      includeShared: true,
      includeProfile: true,
      includeHidden: false,
    };
  }

  private getRepoScopedId(kind: 'repo' | 'workspace' | 'project'): string {
    return createHash('sha1').update(`${kind}:${path.resolve(this.repoRoot)}`).digest('hex').slice(0, 12);
  }

  private nextRepeatedFailures(runState: string, previous: number): number {
    if (runState === 'merged') return 0;
    if (runState === 'failed') return Math.min(previous + 1, 8);
    return previous;
  }

  private updateCircuitState(runState: string): void {
    if (runState === 'failed') {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.CIRCUIT_THRESHOLD) {
        this.circuitOpenUntil = Date.now() + this.CIRCUIT_COOLDOWN_MS;
        nexusEventBus.emit('nexus.circuit-tripped', {
          consecutiveFailures: this.consecutiveFailures,
        });
      }
      return;
    }

    if (runState === 'merged') {
      this.consecutiveFailures = 0;
      this.circuitOpenUntil = 0;
    }
  }

  private getSummaryActiveFiles(): string[] {
    const runtimeSelectedFiles = this.lastRun?.knowledgeFabric?.repo.selectedFiles ?? [];
    const lastRunFiles = this.lastRun?.workerManifests.flatMap((manifest) => manifest.files.map((file) => file.path)) ?? [];
    const modifiedFiles = this.lastRun?.workerResults.flatMap((result) => result.modifiedFiles) ?? [];
    return dedupeStrings([
      ...modifiedFiles,
      ...lastRunFiles,
      ...runtimeSelectedFiles,
    ]).slice(0, 30);
  }

  public getMemoryEngine(): MemoryEngine {
    return this.memory;
  }

  public dispose(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = undefined;
    }
    this.unsubscribePreCompaction?.();
    this.unsubscribePreCompaction = undefined;
    this.compactionSentinel?.stop();
    this.memoryBackgroundWorker?.stop();
    this.persistSessionSummary();
    this.memory.preCompactionFlush('dispose');
    this.memory.flushVaultSync();
    nexusEventBus.emit('orchestrator.disposed', { ts: Date.now() });
  }

  public persistSessionSummary(currentTokenCount?: number) {
    try {
      const projectId = this.getRepoScopedId('project');
      const summarizer = getSharedSummarizer({ projectId });
      const priorSummary = summarizer.bootstrapFromSummary(projectId);
      return summarizer.summarize({
        conversationHistory: this.sessionState.objectiveHistory ?? [],
        activeFiles: this.getSummaryActiveFiles(),
        taskState: this.sessionState.lastPrompt ?? '',
        priorSummaryCount: priorSummary?.priorSummaryCount ?? 0,
        currentTokenCount: currentTokenCount
          ?? this.runtime.getUsageSnapshot().tokens?.grossInputTokens
          ?? this.sessionState.tokenSummary?.grossInputTokens
          ?? 0,
      });
    } catch {
      return null;
    }
  }

  public async bootstrapSession(task: string, options: Partial<ExecutionTask> = {}): Promise<SessionBootstrapResult> {
    const prepared = await new Promise<Awaited<ReturnType<OrchestratorEngine['_prepareExecution']>>>((resolve, reject) => {
      setImmediate(() => {
        this._prepareExecution(task, options).then(resolve, reject);
      });
    });
    const {
      intent,
      phases,
      primaryClient,
      bootstrapManifest,
      latestDNA,
      memoryMatches,
      memoryStats,
      candidateFiles,
      knowledgeFabric,
      planner,
      selections,
      catalogHealth,
      tokenBudget,
      mode,
      taskGraph,
      workerPlan,
      autoGhostPass,
      autoGhostPassDecision,
    } = prepared;
    const autoTokenDecision = this.lifecyclePolicy.evaluate('autoTokenBootstrap', {
      candidateFiles: candidateFiles.length,
      selectedFiles: knowledgeFabric.repo.selectedFiles.length,
      taskPreview: shortLabel(task, 120),
    });
    let autoTokenPlan: ReadingPlan | undefined;
    let autoTokenApplied = false;
    if (autoTokenDecision.enabled && candidateFiles.length >= 1) {
      try {
        const refs = this.toFileRefs(candidateFiles);
        const fileBoosts = this.memory.getFileBoosts(candidateFiles);
        autoTokenPlan = this.tokenEngine.plan(task, refs, fileBoosts);
        autoTokenApplied = true;
      } catch (error: any) {
        console.warn('[Orchestrator] Bootstrap auto token optimization failed, falling back to manual path:', error?.message ?? error);
      }
    }
    // Self-summarization: try to bootstrap from prior session summary to save tokens
    let sessionSummaryBootstrap: SessionBootstrapResult['sessionSummaryBootstrap'];
    const projectHash = this.getRepoScopedId('project');
    try {
      const summarizer = getSharedSummarizer({ projectId: projectHash });
      const priorSummary = summarizer.bootstrapFromSummary(projectHash);
      if (priorSummary) {
        sessionSummaryBootstrap = {
          summary: priorSummary.summary,
          summaryTokens: priorSummary.summaryTokens,
          originalTokens: priorSummary.originalTokens,
          savedTokens: priorSummary.originalTokens - priorSummary.summaryTokens,
        };
        nexusEventBus.emit('session.summaryBootstrap', {
          originalTokens: priorSummary.originalTokens,
          summaryTokens: priorSummary.summaryTokens,
          savedTokens: priorSummary.originalTokens - priorSummary.summaryTokens,
        });
      }
    } catch { /* non-fatal */ }

    const tokenOptimizationRequired = !autoTokenApplied;
    const ragUsageSummary = this.toRagUsageSummary(knowledgeFabric, {
      usedInPlanner: knowledgeFabric.rag.hits.length > 0,
      usedInPacket: false,
      usedInRuntime: false,
    });

    this.sessionState = {
      ...this.sessionState,
      updatedAt: Date.now(),
      lastPrompt: task,
      objectiveHistory: dedupeStrings([task, ...this.sessionState.objectiveHistory]).slice(0, MAX_AUTONOMY_HISTORY),
      phases,
      mode,
      intent,
      selectedCrew: selections.crew,
      selectedSpecialists: selections.specialists,
      selectedSkills: selections.skills,
      selectedWorkflows: selections.workflows,
      selectedHooks: selections.hooks,
      selectedAutomations: selections.automations,
      lastMemoryMatches: memoryMatches.slice(0, 6),
      latestSessionDNA: latestDNA
        ? {
            sessionId: latestDNA.sessionId,
            timestamp: latestDNA.timestamp,
            handoverScore: latestDNA.handoverScore,
          }
        : this.sessionState.latestSessionDNA,
      primaryClient,
    };
    this.persistSessionState();
    this.runtime.recordPrimaryClient(primaryClient, this.listDetectedClients());
    this.runtime.recordOrchestrationSnapshot(this.toRuntimeOrchestrationSnapshot(this.sessionState));
    this.runtime.recordBootstrapManifestStatus(bootstrapManifest);
    this.runtime.recordCatalogHealth(catalogHealth);
    this.runtime.recordArtifactSelectionAudit(selections.audit);
    this.runtime.recordSourceAwareTokenBudget(tokenBudget);
    this.runtime.recordTaskGraph(taskGraph);
    this.runtime.recordWorkerPlan(workerPlan);
    this.runtime.recordRagUsageSummary(ragUsageSummary);
    this.runtime.recordClientToolCall('nexus_session_bootstrap', {
      bootstrapCalled: true,
      plannerCalled: true,
      tokenOptimizationApplied: autoTokenApplied,
      tokenAutoApplied: autoTokenApplied,
    });
    this.ensurePeriodicFlushAndSentinel();

    // First-use project scan: auto-generate a repo-profile memory on first bootstrap
    const repoTree = this.repoTreeGenerator.generate();
    try {
      const existingProfile = await this.memory.recall('#repo-profile', 2, {
        ...this.buildWorkspaceRecallFilters(),
        includeHidden: true,
      });
      const hasProfile = existingProfile.some(m => m.includes('#repo-profile') || m.includes('Repo profile:'));
      if (!hasProfile) {
        const extCounts: Record<string, number> = {};
        const countExtensions = (node: RepoTreeNode) => {
          if (node.type === 'file') {
            const ext = node.name.split('.').pop() || 'other';
            extCounts[ext] = (extCounts[ext] || 0) + 1;
          }
          for (const child of node.children || []) countExtensions(child);
        };
        countExtensions(repoTree);
        const topLangs = Object.entries(extCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ext, count]) => `${ext}(${count})`).join(', ');

        // Detect frameworks from config files
        const frameworks: string[] = [];
        const checkFile = (name: string) => {
          try { return fs.existsSync(path.join(this.repoRoot, name)); } catch { return false; }
        };
        if (checkFile('package.json')) frameworks.push('Node.js');
        if (checkFile('tsconfig.json')) frameworks.push('TypeScript');
        if (checkFile('requirements.txt') || checkFile('pyproject.toml')) frameworks.push('Python');
        if (checkFile('go.mod')) frameworks.push('Go');
        if (checkFile('Cargo.toml')) frameworks.push('Rust');
        if (checkFile('next.config.js') || checkFile('next.config.mjs')) frameworks.push('Next.js');
        if (checkFile('.github/workflows')) frameworks.push('GitHub Actions');

        const profileContent = `Repo profile: ${path.basename(this.repoRoot)} | Languages: ${topLangs} | Frameworks: ${frameworks.join(', ') || 'unknown'} | Files: ${Object.values(extCounts).reduce((a, b) => a + b, 0)}`;
        this.memory.store(profileContent, 0.9, ['#repo-profile', '#workspace', '#system', '#hidden', '#first-use'], undefined, 0, {
          scope: 'project',
          source: 'system',
          provenance: {
            source: 'system',
            repoId: this.getRepoScopedId('repo'),
            workspaceId: this.getRepoScopedId('workspace'),
            projectId: this.getRepoScopedId('project'),
            lane: 'workspace',
            containerTags: ['#repo-profile', '#hidden'],
            summary: 'Hidden repo profile for workspace memory routing.',
          },
        });
      }
    } catch {
      // Non-critical — don't block bootstrap if profiling fails
    }

    return {
      client: primaryClient,
      memoryRecall: {
        count: memoryMatches.length,
        matches: memoryMatches.slice(0, 6),
      },
      memoryStats,
      recommendedNextStep: 'nexus_orchestrate',
      recommendedExecutionMode: mode,
      shortlist: {
        crews: selections.crew ? [selections.crew] : [],
        specialists: selections.specialists,
        skills: selections.skills,
        workflows: selections.workflows,
        hooks: selections.hooks,
        automations: selections.automations,
      },
      tokenOptimization: {
        required: tokenOptimizationRequired,
        reason: autoTokenApplied
          ? 'Auto-applied during bootstrap via lifecycle policy.'
          : tokenBudget.reason,
        candidateFiles: knowledgeFabric.repo.candidateFiles,
        autoApplied: autoTokenApplied,
        plan: autoTokenPlan ? formatReadingPlan(autoTokenPlan) : undefined,
        planMetrics: autoTokenPlan ? {
          files: autoTokenPlan.files.length,
          savings: autoTokenPlan.savings,
          compressedTokens: autoTokenPlan.totalEstimatedTokens,
          originalTokens: autoTokenPlan.totalEstimatedTokens + autoTokenPlan.savings,
          pct: (autoTokenPlan.totalEstimatedTokens + autoTokenPlan.savings) > 0
            ? Math.round(autoTokenPlan.savings / (autoTokenPlan.totalEstimatedTokens + autoTokenPlan.savings) * 100)
            : 0,
        } : undefined,
        policy: {
          feature: autoTokenDecision.feature,
          enabled: autoTokenDecision.enabled,
          reason: autoTokenDecision.reason,
          contextHash: autoTokenDecision.contextHash,
        },
      },
      sessionSummaryBootstrap,
      reviewGates: planner.reviewGates.map((gate) => `${gate.gate}:${gate.status}`),
      catalogHealth,
      sourceMixRecommendation: {
        dominantSource: knowledgeFabric.sourceMix.dominantSource,
        reasons: knowledgeFabric.sourceMix.reasons,
      },
      ragCandidateStatus: this.toRagCandidateStatus(knowledgeFabric),
      clientBootstrapStatus: bootstrapManifest,
      artifactSelectionAudit: selections.audit,
      taskGraphPreview: taskGraph,
      workerPlanPreview: workerPlan,
      knowledgeFabric: {
        summary: knowledgeFabric.summary,
        dominantSource: knowledgeFabric.sourceMix.dominantSource,
        attachedCollections: knowledgeFabric.rag.attachedCollections.map((collection) => collection.name),
        patternHits: knowledgeFabric.patterns.selected.map((pattern) => pattern.name),
        selectedFiles: knowledgeFabric.repo.selectedFiles,
        modelTiers: knowledgeFabric.modelTierTrace.map((trace) => `${trace.stage}:${trace.tier}`),
      },
      autoGhostPass: {
        applied: Boolean(autoGhostPass),
        riskAreas: autoGhostPass?.riskAreas ?? [],
        workerApproaches: autoGhostPass?.workerAssignments?.length ?? 0,
        estimatedTokens: autoGhostPass?.totalEstimatedTokens ?? 0,
        policy: autoGhostPassDecision ?? {
          feature: 'autoGhostPass',
          enabled: false,
          reason: 'missing-policy-evaluation',
          contextHash: 'n/a',
        },
      },
      repoTree,
    };
  }

  private ensurePeriodicFlushAndSentinel(): void {
    if (!this.flushInterval) {
      this.flushInterval = setInterval(() => {
        nexusEventBus.emit('memory.flush-requested', { force: false, reason: 'orchestrator-periodic-flush', itemsFlushed: 0 });
        this.memory.preCompactionFlush('orchestrator-periodic-flush');
      }, 30000);
      this.flushInterval.unref();

      this.unsubscribePreCompaction = nexusEventBus.on('memory.pre-compaction', (payload) => {
        this.memory.preCompactionFlush(payload.reason);
      });
    }

    if (!this.compactionSentinel) {
      this.compactionSentinel = new CompactionSentinel();
      this.compactionSentinel.start();
    }
    this.memoryBackgroundWorker?.start();
  }

  public async orchestrate(task: string, options: Partial<ExecutionTask> = {}): Promise<ExecutionRun> {
    this.checkCircuit();
    const army = await this.induce(task);
    const prepared = await this._prepareExecution(task, options);
    const {
      intent,
      phases,
      primaryClient,
      bootstrapManifest,
      latestDNA,
      memoryMatches,
      memoryStats,
      candidateFiles,
      knowledgeFabric,
      plannedFiles,
      planner,
      selections,
      catalogHealth,
      tokenBudget,
      workerCount,
      mode,
      taskGraph,
      workerPlan,
      autoGhostPass,
    } = prepared;
    this.runtime.recordClientToolCall('nexus_orchestrate', {
      orchestrateCalled: true,
      plannerCalled: true,
    });
    this.ensurePeriodicFlushAndSentinel();
    const ledger = createExecutionLedger({
      sessionId: this.sessionState.sessionId,
      task,
      executionMode: 'autonomous',
      clientId: primaryClient?.clientId,
      clientFamily: primaryClient?.clientFamily,
    });
    markExecutionLedgerStep(ledger, 'identify-client-session', 'completed', {
      summary: primaryClient?.displayName ?? 'No explicit client detected',
      details: {
        clientId: primaryClient?.clientId ?? 'unknown',
        source: primaryClient?.source ?? 'env',
      },
    });
    markExecutionLedgerStep(ledger, 'recall-memory', 'completed', {
      summary: `Recalled ${memoryMatches.length} memory match(es).`,
      details: { matches: memoryMatches.slice(0, 4) },
    });
    nexusEventBus.emit('memory.recall', { query: task, count: memoryMatches.length });
    markExecutionLedgerStep(ledger, 'memory-stats', 'completed', {
      summary: `Loaded memory stats (${memoryStats.cortex} cortex / ${memoryStats.hippocampus} hippocampus).`,
      details: {
        prefrontal: memoryStats.prefrontal,
        hippocampus: memoryStats.hippocampus,
        cortex: memoryStats.cortex,
        totalLinks: memoryStats.totalLinks,
      },
    });
    markExecutionLedgerStep(ledger, 'candidate-file-discovery', 'completed', {
      summary: `${candidateFiles.length} candidate file(s) discovered.`,
      details: {
        files: candidateFiles.slice(0, 24),
        autoGhostPassApplied: Boolean(autoGhostPass),
        autoGhostPassRisks: autoGhostPass?.riskAreas?.length ?? 0,
      },
    });
    markExecutionLedgerStep(ledger, 'knowledge-fabric', 'completed', {
      summary: knowledgeFabric.summary,
      details: {
        dominantSource: knowledgeFabric.sourceMix.dominantSource,
        attachedCollections: knowledgeFabric.rag.attachedCollections.map((collection) => collection.collectionId),
        patternHits: knowledgeFabric.patterns.selected.map((pattern) => pattern.patternId),
      },
    });
    markExecutionLedgerStep(ledger, 'planner-selection', 'completed', {
      summary: `Planner selected ${planner.selectedCrew?.name ?? 'baseline'}.`,
      details: {
        crew: planner.selectedCrew?.crewId ?? null,
        specialists: planner.selectedSpecialists.map((specialist) => specialist.specialistId),
        workflows: planner.selectedWorkflows,
        skills: planner.selectedSkills,
      },
    });
    const tokenPlan = knowledgeFabric.repo.readingPlan;
    markExecutionLedgerStep(ledger, 'catalog-shortlist', 'completed', {
      summary: selections.audit.summary,
      details: {
        selectedCrew: selections.crew,
        specialists: selections.specialists,
        skills: selections.skills,
        workflows: selections.workflows,
        hooks: selections.hooks,
        automations: selections.automations,
      },
    });
    markExecutionLedgerStep(ledger, 'token-optimization', 'completed', {
      summary: `Source-aware budget allocated ${tokenBudget.totalBudget.toLocaleString()} tokens across repo, memory, RAG, patterns, and runtime traces.`,
      details: {
        bySource: tokenBudget.bySource,
        byStage: tokenBudget.byStage,
        dropped: tokenBudget.dropped,
        selectedFiles: plannedFiles,
        estimatedSavings: Number(tokenPlan?.savings ?? 0),
      },
    });
    const ragUsageSummary = this.toRagUsageSummary(knowledgeFabric, {
      usedInPlanner: knowledgeFabric.rag.hits.length > 0,
      usedInPacket: true,
      usedInRuntime: true,
    });
    const governance = this.runtime.previewGovernancePreflight({
      goal: task,
      files: plannedFiles,
      tokenCount: 2500 + plannedFiles.length * 300,
      isDestructive: false,
    });
    markExecutionLedgerStep(ledger, 'governance-preflight', governance.passed ? 'completed' : 'blocked', {
      summary: `Governance preflight score ${governance.score}.`,
      details: {
        passed: governance.passed,
        violations: governance.violations.map((violation) => violation.id),
      },
    });

    const sessionState: SessionAutonomyState = {
      ...this.sessionState,
      updatedAt: Date.now(),
      lastPrompt: task,
      objectiveHistory: dedupeStrings([task, ...this.sessionState.objectiveHistory]).slice(0, MAX_AUTONOMY_HISTORY),
      phases,
      mode,
      intent,
      selectedCrew: selections.crew,
      selectedSpecialists: selections.specialists,
      selectedSkills: selections.skills,
      selectedWorkflows: selections.workflows,
      selectedHooks: selections.hooks,
      selectedAutomations: selections.automations,
      lastMemoryMatches: memoryMatches.slice(0, 6),
      latestSessionDNA: latestDNA
        ? {
            sessionId: latestDNA.sessionId,
            timestamp: latestDNA.timestamp,
            handoverScore: latestDNA.handoverScore,
          }
        : this.sessionState.latestSessionDNA,
      primaryClient,
      continuationDepth: Math.max(this.sessionState.continuationDepth, options.continuationDepth ?? 0),
    };

    this.sessionState = sessionState;
    this.persistSessionState();
    this.runtime.recordPrimaryClient(primaryClient, this.listDetectedClients());
    this.runtime.recordOrchestrationSnapshot(this.toRuntimeOrchestrationSnapshot(sessionState));
    this.runtime.recordBootstrapManifestStatus(bootstrapManifest);
    this.runtime.recordCatalogHealth(catalogHealth);
    this.runtime.recordArtifactSelectionAudit(selections.audit);
    this.runtime.recordSourceAwareTokenBudget(tokenBudget);
    this.runtime.recordTaskGraph(taskGraph);
    this.runtime.recordWorkerPlan(workerPlan);
    this.runtime.recordRagUsageSummary(ragUsageSummary);

    if (tokenPlan) {
      nexusEventBus.emit('tokens.optimized', {
        savings: tokenPlan.savings,
        pct: tokenPlan.totalEstimatedTokens + tokenPlan.savings > 0
          ? Math.round((tokenPlan.savings / (tokenPlan.totalEstimatedTokens + tokenPlan.savings)) * 100)
          : 0,
        files: tokenPlan.files.length,
        inputTokens: tokenPlan.totalEstimatedTokens + tokenPlan.savings,
        outputTokens: tokenPlan.totalEstimatedTokens,
        compressionRatio: tokenPlan.totalEstimatedTokens > 0
          ? (tokenPlan.totalEstimatedTokens + tokenPlan.savings) / tokenPlan.totalEstimatedTokens
          : 0,
        sessionId: sessionState.sessionId,
        phase: 'orchestrator',
        subsystem: 'token-planning',
      });
    }

    const instructionPacket = this.instructionGateway.compile({
      runtimeId: this.runtime.getRuntimeId(),
      sessionId: sessionState.sessionId,
      goal: task,
      executionMode: 'autonomous',
      objectiveHistory: sessionState.objectiveHistory,
      phases,
      requiredSequence: DEFAULT_REQUIRED_SEQUENCE,
      client: primaryClient,
      selectedCrew: planner.selectedCrew,
      selectedSpecialists: planner.selectedSpecialists,
      selectedSkills: this.runtime.listSkills().filter((skill) => selections.skills.includes(skill.name)),
      selectedWorkflows: this.runtime.listWorkflows().filter((workflow) => selections.workflows.includes(workflow.name)),
      selectedHooks: this.runtime.listHooks().filter((hook) => selections.hooks.includes(hook.name)),
      selectedAutomations: this.runtime.listAutomations().filter((automation) => selections.automations.includes(automation.name)),
      catalogShortlist: {
        crews: selections.crew ? [selections.crew] : [],
        specialists: selections.specialists,
        skills: selections.skills,
        workflows: selections.workflows,
        hooks: selections.hooks,
        automations: selections.automations,
      },
      governance: this.toGovernanceSnapshot(governance),
      federation: this.runtime.getUsageSnapshot().federation,
      tokenPolicy: {
        applied: true,
        reason: tokenBudget.reason,
        candidateFiles,
        selectedFiles: plannedFiles,
        estimatedSavings: Number(tokenPlan?.savings ?? 0),
        estimatedCompressionPct: tokenPlan && tokenPlan.totalEstimatedTokens + tokenPlan.savings > 0
          ? Math.round((tokenPlan.savings / (tokenPlan.totalEstimatedTokens + tokenPlan.savings)) * 100)
          : 0,
      },
      memoryMatches,
      memoryStats,
      knowledgeFabric,
      manualOverrides: [],
    });
    this.instructionGateway.persist(instructionPacket, this.repoRoot);
    // Annotate code intelligence peer availability in ledger
    const fedPeers = (this.runtime.getUsageSnapshot().federation as any)?.knownPeers;
    const atlasPeer = Array.isArray(fedPeers) ? fedPeers.find((p: any) => p.id === 'atlas' && p.detected) : null;

    markExecutionLedgerStep(ledger, 'compile-instruction-packet', 'completed', {
      summary: `Compiled instruction packet ${instructionPacket.packetHash}.`,
      details: {
        estimatedTokens: instructionPacket.estimatedTokens,
        ...(atlasPeer ? { codeIntelligence: { available: true, peer: 'atlas', capabilities: atlasPeer.capabilities || [] } } : {}),
      },
    });
    ledger.packetHash = instructionPacket.packetHash;
    this.runtime.recordInstructionPacket(instructionPacket, {
      executionMode: 'autonomous',
      plannerApplied: ledger.plannerApplied,
      tokenOptimizationApplied: ledger.tokenOptimizationApplied,
    });
    this.runtime.recordExecutionLedger(ledger, 'autonomous');

    this.generateOrchestrationPlan(task, intent, workerPlan, instructionPacket);

    army.forEach((agent) => {
      agent.state = 'running';
    });

    const fingerprint = this.getRunFingerprint(
      sessionState.sessionId,
      task,
      primaryClient?.clientId ?? 'unknown',
    );
    const existing = this.executionDedupeStore.get(fingerprint);
    if (existing && (existing.state === 'pending' || existing.state === 'running') && existing.promise) {
      nexusEventBus.emit('ledger.duplicate-prevented', {
        fingerprint,
        existingId: existing.id,
      });
      return existing.promise;
    }

    const runPromise = this.runtime.run({
      ...options,
      goal: task,
      files: options.files?.length ? options.files : plannedFiles,
      workers: workerCount,
      skillNames: selections.skills,
      workflowSelectors: selections.workflows,
      hookSelectors: selections.hooks,
      automationSelectors: selections.automations,
      crewSelectors: options.crewSelectors?.length ? options.crewSelectors : selections.crew ? [selections.crew] : [],
      specialistSelectors: options.specialistSelectors?.length ? options.specialistSelectors : selections.specialists,
      optimizationProfile: options.optimizationProfile ?? planner.optimizationProfile,
      executionMode: 'autonomous',
      manualOverrides: [],
      instructionPacket,
      executionLedger: ledger,
      knowledgeFabric,
    });
    this.executionDedupeStore.set(fingerprint, {
      id: ledger.runId,
      state: 'running',
      ts: Date.now(),
      promise: runPromise,
    });
    let run: ExecutionRun;
    try {
      run = await runPromise;
    } catch (error) {
      this.executionDedupeStore.set(fingerprint, {
        id: ledger.runId,
        state: 'failed',
        ts: Date.now(),
      });
      setTimeout(() => this.executionDedupeStore.delete(fingerprint), 120_000).unref();
      const envErrors = ['EROFS', 'ENOENT', 'EACCES', 'EPERM'];
      if (envErrors.includes((error as any)?.code)) {
        console.error('[Orchestrator] Env error (not orchestration failure):', (error as any).code);
      } else {
        this.updateCircuitState('failed');
      }
      throw error;
    }
    this.executionDedupeStore.set(fingerprint, {
      id: run.runId,
      state: run.state,
      ts: Date.now(),
    });
    setTimeout(() => this.executionDedupeStore.delete(fingerprint), 120_000).unref();
    this.lastRun = run;
    const artifactOutcome = this.buildArtifactOutcome(selections.audit, run);

    army.forEach((agent) => {
      agent.state = run.state === 'failed' ? 'failed' : 'complete';
      agent.result = run.result;
    });

    this.sessionState = {
      ...sessionState,
      updatedAt: Date.now(),
      repeatedFailures: this.nextRepeatedFailures(run.state, sessionState.repeatedFailures),
      continuationDepth: Math.max(sessionState.continuationDepth, run.continuationChildren.length > 0 ? 1 : 0),
      lastRunId: run.runId,
      tokenSummary: this.runtime.getTokenTelemetrySummary(),
      artifactOutcomeHistory: this.mergeArtifactOutcomeHistory(this.sessionState.artifactOutcomeHistory, artifactOutcome),
      selectedCrew: run.plannerState?.selectedCrew?.crewId ?? sessionState.selectedCrew,
      selectedSpecialists: run.plannerState?.selectedSpecialists?.map((specialist) => specialist.specialistId) ?? sessionState.selectedSpecialists,
      selectedSkills: run.activeSkills.map((skill) => skill.name),
      selectedWorkflows: run.activeWorkflows.map((workflow) => workflow.name),
      selectedHooks: run.activeHooks.map((hook) => hook.name),
      selectedAutomations: run.activeAutomations.map((automation) => automation.name),
    };
    this.persistSessionState();
    try {
      if (tokenPlan) {
        const { accumulateLifetimeTokens } = await import('./lifetime-tokens.js');
        accumulateLifetimeTokens({
          savedTokens: tokenPlan.savings ?? 0,
          grossInputTokens: (tokenPlan.totalEstimatedTokens ?? 0) + (tokenPlan.savings ?? 0),
          compressedTokens: tokenPlan.totalEstimatedTokens ?? 0,
        });
      }
    } catch { /* non-critical */ }
    this.runtime.recordOrchestrationSnapshot(this.toRuntimeOrchestrationSnapshot(this.sessionState));
    this.runtime.recordPrimaryClient(primaryClient, this.listDetectedClients());
    this.runtime.recordArtifactOutcome(artifactOutcome);
    markExecutionLedgerStep(ledger, 'runtime-execution', run.state === 'failed' ? 'failed' : 'completed', {
      summary: run.result,
      details: {
        runId: run.runId,
        state: run.state,
        verifiedWorkers: run.workerResults.filter((worker) => worker.verified).length,
      },
    });

    this.updateCircuitState(run.state);
    
    // Self-Learning Skill Loop: Analyze the run outcome and promote/derive skills
    this.skillLearner.analyzeRun(ledger, instructionPacket);

    await this.runtime.storeMemoryAndDispatch(
      `Orchestrated run ${run.runId}: ${task} -> ${run.state} (${run.result})`,
      run.state === 'merged' ? 0.88 : 0.72,
      ['#orchestrator', '#session', `#${run.state}`],
      undefined,
      undefined,
      {
        continuationDepth: options.continuationDepth ?? 0,
        sourceAutomationId: options.sourceAutomationId,
        suppressAutomationContinuations: true,
      },
    );
    const memoryScopeUsage = this.runtime.getMemoryScopeUsage();
    const memoryReconciliationSummary = this.runtime.getMemoryReconciliationSummary();
    this.runtime.recordMemoryScopeUsage(memoryScopeUsage);
    this.runtime.recordMemoryReconciliationSummary(memoryReconciliationSummary);
    markExecutionLedgerStep(ledger, 'structured-learning', 'completed', {
      summary: 'Stored orchestrator session learning and refreshed runtime metadata.',
      details: { runId: run.runId },
    });
    run.executionLedger = ledger;
    run.instructionPacket = instructionPacket;
    run.knowledgeFabric = knowledgeFabric;
    run.taskGraph = taskGraph;
    run.workerPlan = workerPlan;
    run.artifactOutcome = artifactOutcome;
    run.ragUsageSummary = ragUsageSummary;
    run.memoryScopeUsage = memoryScopeUsage;
    run.memoryReconciliationSummary = memoryReconciliationSummary;
    run.autoGhostPass = autoGhostPass;
    this.runtime.recordExecutionLedger(ledger, 'autonomous');
    this.runtime.recordInstructionPacket(instructionPacket, {
      executionMode: 'autonomous',
      plannerApplied: ledger.plannerApplied,
      tokenOptimizationApplied: ledger.tokenOptimizationApplied,
    });
    this.runtime.recordKnowledgeFabricSnapshot(this.knowledgeFabric.getSessionSnapshot(this.runtime.getRuntimeId()));
    this.runtime.updateExecutionMetadata(run.runId, {
      instructionPacket,
      executionLedger: ledger,
      knowledgeFabric,
    });

    return run;
  }

  /**
   * Backward-compatible alias for the old high-level entrypoint.
   */
  public async executeSwarm(task: string, options?: Partial<ExecutionTask>): Promise<ExecutionRun> {
    return this.orchestrate(task, options);
  }

  public getAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  public getLastRun(): ExecutionRun | null {
    return this.lastRun;
  }

  public getSessionState(): SessionAutonomyState {
    return this.sessionState;
  }

  public getKnowledgeFabricSnapshot() {
    return this.knowledgeFabric.getSessionSnapshot(this.runtime.getRuntimeId());
  }

  public getKnowledgeFabricProvenance() {
    return this.knowledgeFabric.getProvenance(this.runtime.getRuntimeId());
  }

  public listRagCollections() {
    return this.knowledgeFabric.listCollections();
  }

  public getRagCollection(collectionId: string) {
    return this.knowledgeFabric.getCollection(collectionId);
  }

  public createRagCollection(input: { name: string; description?: string; tags?: string[]; scope?: 'session' | 'project' }) {
    return this.knowledgeFabric.createCollection(input);
  }

  public async ingestRagCollection(collectionId: string, inputs: Array<{ filePath?: string; url?: string; text?: string; label?: string; tags?: string[] }>) {
    return this.knowledgeFabric.ingestCollection(collectionId, inputs);
  }

  public attachRagCollection(collectionId: string) {
    const collection = this.knowledgeFabric.attachCollection(collectionId, this.runtime.getRuntimeId(), this.sessionState.sessionId);
    this.runtime.recordKnowledgeFabricSnapshot(this.knowledgeFabric.getSessionSnapshot(this.runtime.getRuntimeId()));
    return collection;
  }

  public detachRagCollection(collectionId: string) {
    const collection = this.knowledgeFabric.detachCollection(collectionId, this.runtime.getRuntimeId(), this.sessionState.sessionId);
    this.runtime.recordKnowledgeFabricSnapshot(this.knowledgeFabric.getSessionSnapshot(this.runtime.getRuntimeId()));
    return collection;
  }

  public deleteRagCollection(collectionId: string) {
    return this.knowledgeFabric.deleteCollection(collectionId);
  }

  public listPatterns() {
    return this.knowledgeFabric.listPatterns();
  }

  public searchPatterns(query: string, limit: number = 6) {
    return this.knowledgeFabric.searchPatterns(query, limit);
  }

  public getModelTierTrace() {
    return this.knowledgeFabric.getModelTiers(this.runtime.getRuntimeId());
  }

  public async plan(task: string, options?: Partial<ExecutionTask>) {
    return this.runtime.planExecution({
      goal: task,
      files: options?.files,
      skillNames: options?.skillNames,
      workflowSelectors: options?.workflowSelectors,
      crewSelectors: options?.crewSelectors,
      specialistSelectors: options?.specialistSelectors,
      optimizationProfile: options?.optimizationProfile,
      workers: options?.workers,
    });
  }

  private composeKnowledgeFabric(
    task: string,
    candidateFiles: string[],
    memoryMatches: string[],
    intent: AutonomyIntent,
    memoryMatchesFull?: Array<{ content: string; confidence: number; entropy: number; trust: number }>,
    fileBoosts?: Map<string, number>,
  ): KnowledgeFabricBundle {
    const bundle = this.knowledgeFabric.compose({
      runtimeId: this.runtime.getRuntimeId(),
      sessionId: this.sessionState.sessionId,
      task,
      candidateFiles,
      memoryMatches,
      memoryMatchesWithQuality: memoryMatchesFull,
      fileBoosts,
      runtimeSnapshot: this.runtime.getUsageSnapshot() as RuntimeRegistrySnapshot,
      intent,
    });
    this.runtime.recordKnowledgeFabricSnapshot(this.knowledgeFabric.getSessionSnapshot(this.runtime.getRuntimeId()));
    return bundle;
  }

  private loadSessionState(): SessionAutonomyState {
    const target = this.sessionStatePath();
    if (fs.existsSync(target)) {
      try {
        return JSON.parse(fs.readFileSync(target, 'utf8')) as SessionAutonomyState;
      } catch {
        const corruptPath = target.replace(/\.json$/, `.corrupt-${Date.now()}.json`);
        try {
          fs.copyFileSync(target, corruptPath);
        } catch {
          // ignore backup failures
        }
        console.error('[Orchestrator] Corrupt session file backed up to:', corruptPath);
      }
    }

    const sessionId = this.sessionDNA?.getSessionId?.() ?? `autonomy-${randomUUID().slice(0, 8)}`;
    return {
      runtimeId: this.runtime.getRuntimeId(),
      sessionId,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      lastPrompt: '',
      objectiveHistory: [],
      phases: [],
      mode: 'single-pass',
      repeatedFailures: 0,
      continuationDepth: 0,
      intent: { taskType: 'feature', riskClass: 'medium', complexity: 1 },
      selectedSpecialists: [],
      selectedSkills: [],
      selectedWorkflows: [],
      selectedHooks: [],
      selectedAutomations: [],
      lastMemoryMatches: [],
      artifactOutcomeHistory: {},
    };
  }

  private persistSessionState(): void {
    try {
      fs.writeFileSync(this.sessionStatePath(), JSON.stringify(this.sessionState, null, 2), 'utf8');
    } catch (err: any) {
      console.error('[Orchestrator] Failed to persist session state:', err?.message);
    }
  }

  private sessionStatePath(): string {
    return path.join(this.sessionsDir, `${this.runtime.getRuntimeId()}.json`);
  }

  /** Remove autonomy-session files older than 14 days */
  private pruneStaleAutonomySessions(): void {
    try {
      const TTL_MS = 14 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      for (const entry of fs.readdirSync(this.sessionsDir)) {
        if (!entry.endsWith('.json')) continue;
        const filePath = path.join(this.sessionsDir, entry);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > TTL_MS) {
            fs.unlinkSync(filePath);
          }
        } catch { /* best-effort */ }
      }
    } catch { /* best-effort */ }
  }

  private resolvePrimaryClient(): RuntimePrimaryClientSnapshot | undefined {
    const primary = this.clientRegistry?.getPrimaryClient?.();
    if (primary) return this.toClientSnapshot(primary);
    const detected = this.detectCurrentClientFromEnv();
    return detected ? this.toClientSnapshot(detected) : undefined;
  }

  private listDetectedClients(): RuntimePrimaryClientSnapshot[] {
    const clients = this.clientRegistry?.listClients?.() ?? [];
    if (clients.length === 0) {
      const detected = this.detectCurrentClientFromEnv();
      return detected ? [this.toClientSnapshot(detected)] : [];
    }
    return clients.map((client) => this.toClientSnapshot(client));
  }

  private detectCurrentClientFromEnv(): ClientRecord | undefined {
    if (process.env.CODEX_HOME || process.env.CODEX_SESSION) {
      return {
        clientId: 'codex',
        displayName: 'Codex',
        state: 'primaryActive',
        source: 'manual',
        inferred: false,
        confidence: 1,
        evidence: ['env:CODEX detected'],
        metadata: {},
        lastSeen: Date.now(),
      };
    }
    if (process.env.CURSOR_HOME || process.env.CURSOR_SESSION) {
      return {
        clientId: 'cursor',
        displayName: 'Cursor',
        state: 'primaryActive',
        source: 'manual',
        inferred: false,
        confidence: 1,
        evidence: ['env:CURSOR detected'],
        metadata: {},
        lastSeen: Date.now(),
      };
    }
    if (process.env.CLAUDE_CODE || process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_PROJECT_DIR) {
      return {
        clientId: 'claude-code',
        displayName: 'Claude Code',
        state: 'primaryActive',
        source: 'manual',
        inferred: false,
        confidence: 1,
        evidence: ['env:CLAUDE detected'],
        metadata: {},
        lastSeen: Date.now(),
      };
    }
    if (process.env.OPENCODE_HOME) {
      return {
        clientId: 'opencode',
        displayName: 'Opencode',
        state: 'primaryActive',
        source: 'manual',
        inferred: false,
        confidence: 1,
        evidence: ['env:OPENCODE detected'],
        metadata: {},
        lastSeen: Date.now(),
      };
    }
    if (process.env.OPENCLAW_HOME || process.env.ANTIGRAVITY_HOME) {
      return {
        clientId: 'antigravity',
        displayName: 'Antigravity',
        state: 'primaryActive',
        source: 'manual',
        inferred: false,
        confidence: 1,
        evidence: ['env:ANTIGRAVITY detected'],
        metadata: {},
        lastSeen: Date.now(),
      };
    }
    if (process.env.WINDSURF_HOME || process.env.WINDSURF_SESSION) {
      return {
        clientId: 'windsurf',
        displayName: 'Windsurf',
        state: 'primaryActive',
        source: 'manual',
        inferred: false,
        confidence: 1,
        evidence: ['env:WINDSURF detected'],
        metadata: {},
        lastSeen: Date.now(),
      };
    }
    return undefined;
  }

  private toClientSnapshot(client: ClientRecord): RuntimePrimaryClientSnapshot {
    return {
      clientId: client.clientId,
      clientFamily: this.toClientFamily(client.clientId),
      displayName: client.displayName,
      state: client.state as RuntimePrimaryClientSnapshot['state'],
      source: client.source,
      confidence: client.confidence,
      evidence: client.evidence,
      lastSeen: client.lastSeen,
    };
  }

  private toRuntimeOrchestrationSnapshot(state: SessionAutonomyState): RuntimeOrchestrationSnapshot {
    return {
      sessionId: state.sessionId,
      lastPrompt: state.lastPrompt,
      taskType: state.intent.taskType,
      riskClass: state.intent.riskClass,
      mode: state.mode,
      phases: state.phases,
      objectiveHistory: state.objectiveHistory,
      selectedCrew: state.selectedCrew,
      selectedSpecialists: state.selectedSpecialists,
      selectedSkills: state.selectedSkills,
      selectedWorkflows: state.selectedWorkflows,
      selectedHooks: state.selectedHooks,
      selectedAutomations: state.selectedAutomations,
      repeatedFailures: state.repeatedFailures,
      continuationDepth: state.continuationDepth,
      latestSessionDNA: state.latestSessionDNA,
      lastUpdatedAt: state.updatedAt,
    };
  }

  private toGovernanceSnapshot(result: ReturnType<SubAgentRuntime['previewGovernancePreflight']>): GovernanceSnapshot {
    return {
      passed: result.passed,
      score: result.score,
      violations: result.violations.map((violation) => violation.id),
      suggestions: result.warnings.map((warning) => warning.id),
    };
  }

  private toClientFamily(clientId?: string): string {
    const normalized = String(clientId ?? 'codex').toLowerCase();
    if (normalized === 'openclaw' || normalized === 'antigravity') return 'antigravity';
    return normalized;
  }

  private classifyIntent(task: string): AutonomyIntent {
    const lowerTask = task.toLowerCase();
    const taskTokens = new Set(
      lowerTask.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((word) => word.length > 2)
    );
    const intents: Record<AutonomyIntent['taskType'], { keywords: string[]; phrases?: string[]; weight?: number }> = {
      release: { keywords: ['release', 'publish', 'tag', 'version', 'deploy', 'bump'], phrases: ['release readiness', 'ship it'] },
      feature: { keywords: ['feature', 'add', 'implement', 'build', 'create', 'develop', 'enable', 'introduce', 'extend', 'enhance'], weight: 0.95 },
      review: { keywords: ['review', 'audit', 'check', 'inspect', 'assess', 'verify', 'readiness', 'cto'], phrases: ['lead review', 'production ready', 'world class'] },
      research: { keywords: ['research', 'explore', 'discover', 'spike', 'feasibility', 'investigate', 'analyze', 'evaluate'], weight: 0.9 },
      refactor: { keywords: ['refactor', 'rewrite', 'restructure', 'clean', 'extract', 'reorganize', 'harden'], phrases: ['tech debt'] },
      bugfix: { keywords: ['fix', 'bug', 'broken', 'issue', 'error', 'crash', 'exception', 'patch', 'resolve', 'lag', 'slow'], phrases: ['not working', 'super buggy'] },
      ops: { keywords: ['deploy', 'monitor', 'ops', 'infra', 'devops', 'docker', 'kubernetes', 'pipeline', 'workflow'], phrases: ['ci/cd'] },
      pm: { keywords: ['pm', 'roadmap', 'requirements', 'scope', 'prd', 'story', 'plan', 'spec', 'ticket', 'epic'], phrases: ['user story', 'product requirement'], weight: 0.8 },
      test: { keywords: ['test', 'coverage', 'jest', 'cypress', 'e2e', 'unit', 'integration', 'qa', 'validate', 'regression'], weight: 0.92 },
      frontend: { keywords: ['frontend', 'ui', 'ux', 'react', 'css', 'styling', 'components', 'layout', 'design', 'html', 'page', 'dashboard'], phrases: ['user experience', 'design system'], weight: 1.05 },
      backend: { keywords: ['backend', 'api', 'server', 'database', 'sql', 'endpoint', 'controller', 'service', 'binding', 'runtime', 'synapse', 'architects', 'orchestration', 'pod'], phrases: ['control plane', 'multi agent', 'multiagent'], weight: 1.08 },
      ai: { keywords: ['ai', 'ml', 'llm', 'rag', 'embedding', 'prompt', 'inference', 'agent', 'model'], weight: 0.95 },
      marketing: { keywords: ['marketing', 'seo', 'copywriting', 'campaign', 'blog', 'content', 'growth', 'social', 'email'], weight: 0.65 },
      sales: { keywords: ['sales', 'pitch', 'lead', 'prospecting', 'outreach', 'crm', 'deal', 'quote'], weight: 0.65 },
      data: { keywords: ['analysis', 'data', 'metrics', 'query', 'analytics', 'report', 'etl', 'bi'], phrases: ['data warehouse'], weight: 0.72 },
    };

    const scoreKeyword = (keyword: string): number => {
      if (taskTokens.has(keyword)) return 1;
      if (lowerTask.includes(keyword)) return keyword.includes(' ') ? 1.15 : 0.55;
      return 0;
    };

    const intentScores: Record<string, number> = {};
    for (const [type, config] of Object.entries(intents)) {
      let score = 0;
      for (const keyword of config.keywords) {
        score += scoreKeyword(keyword);
      }
      for (const phrase of config.phrases ?? []) {
        if (lowerTask.includes(phrase)) score += 1.35;
      }
      intentScores[type] = score * (config.weight ?? 1);
    }

    const hasTechnicalScope = /(dashboard|frontend|backend|api|runtime|control plane|synapse|architect|pod|integration|binding|coordination)/.test(lowerTask);
    const hasAuditPressure = /(review|audit|cto|lag|slow|bug|fix|broken|performance|harden|readiness|not working)/.test(lowerTask);
    const isTechnicalAudit = hasTechnicalScope && hasAuditPressure;
    if (isTechnicalAudit) {
      intentScores.review += 1.2;
      intentScores.backend += 1.35;
      intentScores.frontend += 0.95;
      intentScores.bugfix += 0.75;
      intentScores.pm *= 0.45;
      intentScores.marketing *= 0.2;
      intentScores.sales *= 0.2;
      if (/(dashboard|ui|ux)/.test(lowerTask) && /(lag|slow|bug|performance|frontend|binding|api)/.test(lowerTask)) {
        intentScores.data *= 0.25;
      }
    }

    if (/(dashboard|metrics|analytics)/.test(lowerTask) && !/(ui|ux|frontend|lag|performance|bug|control plane|runtime)/.test(lowerTask)) {
      intentScores.data += 0.8;
    }
    if (/(build|create|implement|add|new|enhance|extend|develop)/.test(lowerTask) && !/(review|audit|fix|bug|lag|broken|readiness)/.test(lowerTask)) {
      intentScores.feature += 1.65;
    }

    // Sort by score descending to find primary and potential secondary intent
    const sorted = Object.entries(intentScores).sort((a, b) => b[1] - a[1]);
    const bestIntent = sorted[0]?.[1] > 0 ? sorted[0][0] : 'feature';
    const bestScore = sorted[0]?.[1] ?? 0;
    // Secondary intent: if 2nd place score >= 80% of 1st place, it's a meaningful secondary signal
    const secondaryThreshold = isTechnicalAudit ? 0.45 : 0.8;
    const threshold = Math.max(secondaryThreshold * bestScore, ABSOLUTE_SECONDARY_MIN);
    const secondaryType = sorted[1]?.[1] > 0 && bestScore > 0 && sorted[1][1] >= threshold
        ? sorted[1][0]
        : undefined;

    const taskType = bestIntent as AutonomyIntent['taskType'];
      
    const riskKeywords = {
        high: ['delete', 'migrate', 'release', 'security', 'auth', 'drop', 'production', 'secret', 'destroy'],
        medium: ['refactor', 'planner', 'orchestr', 'update', 'modify', 'change', 'replace'],
    };
    
    let bestRisk: AutonomyIntent['riskClass'] = 'low';
    let highestRiskScore = 0;
    
    for (const [risk, keywords] of Object.entries(riskKeywords)) {
        let score = 0;
        for (const kw of keywords) {
            if (taskTokens.has(kw)) score += 1.0;
            else if (task.toLowerCase().includes(kw)) score += 0.5;
        }
        if (score > highestRiskScore) {
            highestRiskScore = score;
            bestRisk = risk as AutonomyIntent['riskClass'];
        }
    }
    
    // Safety override: if high risk keywords present, force high risk
    if (highestRiskScore > 0 && bestRisk !== 'high') {
        const hasHighRisk = riskKeywords.high.some(kw => taskTokens.has(kw) || task.toLowerCase().includes(kw));
        if (hasHighRisk) bestRisk = 'high';
    }

    const riskClass = bestRisk;
    const complexity = Math.max(1, Math.min(6, this.decomposeTask(task).length + (task.length > 120 ? 1 : 0) + (riskClass === 'high' ? 1 : 0)));
    return { taskType, secondaryType, intentScores, riskClass, complexity };
  }

  private discoverCandidateFiles(task: string, dna?: SessionDNA | null): string[] {
    const keywords = extractKeywords(task);
    // Build a set of files from previous session DNA for boosting
    const dnaFiles = new Set<string>();
    if (dna) {
      for (const f of [...(dna.filesAccessed ?? []), ...(dna.filesModified ?? [])]) {
        dnaFiles.add(f);
      }
    }
    const candidates = this.walkRepo(this.repoRoot)
      .map((filePath) => ({
        filePath,
        score: scorePath(filePath, keywords) + (dnaFiles.has(filePath) ? 0.3 : 0),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath))
      .slice(0, MAX_DISCOVERED_FILES)
      .map((entry) => entry.filePath);

    if (candidates.length > 0) {
      return candidates;
    }

    const srcFiles = (() => {
      try {
        return fs.readdirSync(path.join(this.repoRoot, 'src'))
          .filter((entry) => entry.endsWith('.ts'))
          .map((entry) => path.join(this.repoRoot, 'src', entry));
      } catch {
        return [];
      }
    })();

    return ['README.md', 'package.json', ...srcFiles]
      .map((entry) => entry.startsWith(this.repoRoot) ? entry : path.join(this.repoRoot, entry))
      .filter((entry) => fs.existsSync(entry));
  }

  private walkRepo(root: string, seen: string[] = []): string[] {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      // Gracefully skip inaccessible directories (EACCES, EPERM, etc.)
      return seen;
    }
    for (const entry of entries) {
      if (DISCOVERY_IGNORES.has(entry.name)) continue;
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        this.walkRepo(fullPath, seen);
        continue;
      }
      if (!DISCOVERY_EXTENSIONS.has(path.extname(entry.name))) continue;
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > 200_000) continue;
      } catch {
        continue;
      }
      seen.push(fullPath);
    }
    return seen;
  }

  private toFileRef(filePath: string): FileRef | undefined {
    try {
      const stat = fs.statSync(filePath);
      return {
        path: filePath,
        sizeBytes: stat.size,
        lastModified: stat.mtimeMs,
      };
    } catch {
      return undefined;
    }
  }

  private resolveSelections(
    task: string,
    intent: AutonomyIntent,
    planner: Awaited<ReturnType<SubAgentRuntime['planExecution']>>,
    knowledgeFabric: KnowledgeFabricBundle,
    options: Partial<ExecutionTask>,
  ): ResolvedSelections {
    const skillItems = this.runtime.listSkills().map((skill) => ({
      id: skill.skillId,
      name: skill.name,
      body: `${skill.name}\n${skill.instructions}\n${skill.provenance}`,
    }));
    const workflowItems = this.runtime.listWorkflows().map((workflow) => ({
      id: workflow.workflowId,
      name: workflow.name,
      body: `${workflow.name}\n${workflow.description}\n${workflow.domain}`,
    }));
    const hookItems = this.runtime.listHooks().map((hook) => ({
      id: hook.hookId,
      name: hook.name,
      body: `${hook.name}\n${hook.description}\n${hook.trigger}`,
    }));
    const automationItems = this.runtime.listAutomations().map((automation) => ({
      id: automation.automationId,
      name: automation.name,
      body: `${automation.name}\n${automation.description}\n${automation.triggerMode}\n${automation.eventTrigger ?? ''}`,
    }));
    const specialistItems = this.runtime.listSpecialists().map((specialist) => ({
      id: specialist.specialistId,
      name: specialist.name,
      body: `${specialist.name}\n${specialist.description}\n${specialist.mission}\n${specialist.domains.join(' ')}`,
    }));
    const crewItems = this.runtime.listCrews().map((crew) => ({
      id: crew.crewId,
      name: crew.name,
      body: `${crew.name}\n${crew.summary}\n${crew.domains.join(' ')}`,
    }));

    const skillSelection = this.resolveCatalogVotes('skill', task, intent, skillItems, {
      explicit: options.skillNames,
      planner: planner.selectedSkills,
      knowledge: knowledgeFabric.recommendations.skills,
      scorerLimit: 5,
      limit: 5,
      selector: 'name',
    });
    const workflowSelection = this.resolveCatalogVotes('workflow', task, intent, workflowItems, {
      explicit: options.workflowSelectors,
      planner: planner.selectedWorkflows,
      knowledge: knowledgeFabric.recommendations.workflows,
      scorerLimit: 4,
      limit: 4,
      selector: 'name',
    });
    const hookSelection = this.resolveCatalogVotes('hook', task, intent, hookItems, {
      explicit: options.hookSelectors,
      planner: [],
      knowledge: knowledgeFabric.recommendations.hooks,
      scorerLimit: intent.riskClass === 'high' ? 3 : 2,
      limit: intent.riskClass === 'high' ? 3 : 2,
      selector: 'name',
    });
    const automationSelection = this.resolveCatalogVotes('automation', task, intent, automationItems, {
      explicit: options.automationSelectors,
      planner: [],
      knowledge: knowledgeFabric.recommendations.automations,
      scorerLimit: intent.taskType === 'release' || this.sessionState.repeatedFailures > 0 ? 3 : 2,
      limit: intent.taskType === 'release' || this.sessionState.repeatedFailures > 0 ? 3 : 2,
      selector: 'name',
    });
    const specialistSelection = this.resolveCatalogVotes('specialist', task, intent, specialistItems, {
      explicit: options.specialistSelectors,
      planner: planner.selectedSpecialists.map((specialist) => specialist.specialistId),
      knowledge: knowledgeFabric.recommendations.specialists,
      scorerLimit: 4,
      limit: 4,
      selector: 'id',
    });
    const crewSelection = this.resolveCatalogVotes('crew', task, intent, crewItems, {
      explicit: options.crewSelectors,
      planner: planner.selectedCrew ? [planner.selectedCrew.crewId] : [],
      knowledge: knowledgeFabric.recommendations.crews,
      scorerLimit: 2,
      limit: 1,
      selector: 'id',
    });

    const selected = [
      ...skillSelection.selectedEntries,
      ...workflowSelection.selectedEntries,
      ...hookSelection.selectedEntries,
      ...automationSelection.selectedEntries,
      ...specialistSelection.selectedEntries,
      ...crewSelection.selectedEntries,
    ];
    const rejected = [
      ...skillSelection.rejectedEntries,
      ...workflowSelection.rejectedEntries,
      ...hookSelection.rejectedEntries,
      ...automationSelection.rejectedEntries,
      ...specialistSelection.rejectedEntries,
      ...crewSelection.rejectedEntries,
    ];

    return {
      crew: crewSelection.selectedValues[0],
      specialists: specialistSelection.selectedValues,
      skills: skillSelection.selectedValues,
      workflows: workflowSelection.selectedValues,
      hooks: hookSelection.selectedValues,
      automations: automationSelection.selectedValues,
      audit: {
        generatedAt: Date.now(),
        summary: selected.length > 0
          ? `Selected ${selected.length} artifact(s) after planner, knowledge-fabric, and scorer audit.`
          : 'Selector confidence stayed low, so Nexus fell back to the stable baseline runtime instead of injecting weak or cross-domain artifacts.',
        selected,
        rejected,
      },
    };
  }

  private resolveCatalogVotes(
    kind: RuntimeArtifactSelectionAudit['selected'][number]['kind'],
    task: string,
    intent: AutonomyIntent,
    items: CatalogItem[],
    input: {
      explicit?: string[];
      planner?: string[];
      knowledge?: string[];
      scorerLimit: number;
      limit: number;
      selector: 'id' | 'name';
    },
  ): {
    selectedValues: string[];
    selectedEntries: RuntimeArtifactSelectionAudit['selected'];
    rejectedEntries: RuntimeArtifactSelectionAudit['rejected'];
  } {
    const explicit = dedupeStrings(input.explicit ?? []);
    if (explicit.length > 0) {
      const selectedEntries = explicit.map((value) => this.toArtifactAuditEntry(kind, value, items, {
        score: 1,
        source: 'explicit',
        confidence: 'high',
        reason: 'User provided a hard constraint.',
        selector: input.selector,
      }));
      return { selectedValues: explicit, selectedEntries, rejectedEntries: [] };
    }

    const votes = new Map<string, {
      value: string;
      item?: CatalogItem;
      score: number;
      source: 'explicit' | 'planner' | 'knowledge-fabric' | 'scorer';
      confidence: 'high' | 'medium' | 'low';
      reasons: string[];
    }>();

    const applyVote = (
      value: string,
      source: 'planner' | 'knowledge-fabric' | 'scorer',
      score: number,
      confidence: 'high' | 'medium' | 'low',
      reason: string,
    ) => {
      const key = value.trim();
      if (!key) return;
      const item = items.find((entry) => (input.selector === 'id' ? entry.id === key : entry.name === key));
      const existing = votes.get(key);
      if (existing) {
        existing.score += score;
        existing.reasons.push(reason);
        if (source === 'planner' || (source === 'knowledge-fabric' && existing.source === 'scorer')) {
          existing.source = source;
        }
        if (confidence === 'high' || (confidence === 'medium' && existing.confidence === 'low')) {
          existing.confidence = confidence;
        }
        if (item && !existing.item) existing.item = item;
        return;
      }
      votes.set(key, {
        value: key,
        item,
        score,
        source,
        confidence,
        reasons: [reason],
      });
    };

    (input.planner ?? []).forEach((value) => {
      applyVote(value, 'planner', 0.92, 'high', 'Planner selected this artifact for the run.');
    });
    (input.knowledge ?? []).forEach((value) => {
      applyVote(value, 'knowledge-fabric', 0.76, 'medium', 'Knowledge Fabric recommended this artifact from cross-source evidence.');
    });
    this.pickCatalogEntries(task, intent, items, input.scorerLimit).forEach((entry) => {
      applyVote(input.selector === 'id' ? entry.item.id : entry.item.name, 'scorer', Math.min(0.7, entry.score / 10), entry.score >= 9 ? 'medium' : 'low', `Keyword scorer matched the task with score ${entry.score}.`);
    });

    const ranked = [...votes.values()]
      .map((entry) => {
        const artifactId = entry.item?.id ?? entry.value;
        const historyScore = this.getArtifactHistoryScore(kind, artifactId);
        return {
          ...entry,
          score: entry.score + historyScore,
          reasons: historyScore
            ? [...entry.reasons, `Historical effectiveness adjusted score by ${historyScore.toFixed(2)}.`]
            : entry.reasons,
        };
      })
      .sort((left, right) => right.score - left.score || (left.item?.name ?? left.value).localeCompare(right.item?.name ?? right.value));
    const selected = ranked
      .filter((entry) => this.isCatalogVoteSelected(entry))
      .slice(0, input.limit);
    const rejected = ranked
      .filter((entry) => !selected.some((candidate) => candidate.value === entry.value))
      .slice(0, 8);

    return {
      selectedValues: selected.map((entry) => entry.value),
      selectedEntries: selected.map((entry) => this.toArtifactAuditEntry(kind, entry.value, items, {
        score: entry.score,
        source: entry.source,
        confidence: entry.confidence,
        reason: entry.reasons.join(' '),
        selector: input.selector,
      })),
      rejectedEntries: rejected.map((entry) => this.toArtifactAuditEntry(kind, entry.value, items, {
        score: entry.score,
        source: entry.source,
        confidence: entry.confidence,
        reason: `Rejected after audit. ${entry.reasons.join(' ')}`,
        selector: input.selector,
      }, false)),
    };
  }

  private isCatalogVoteSelected(entry: {
    score: number;
    source: 'explicit' | 'planner' | 'knowledge-fabric' | 'scorer';
    confidence: 'high' | 'medium' | 'low';
  }): boolean {
    if (entry.source === 'explicit' || entry.source === 'planner') return true;
    if (entry.source === 'knowledge-fabric') return entry.score >= 0.72 || entry.confidence !== 'low';
    return entry.score > 0;
  }

  private toArtifactAuditEntry(
    kind: RuntimeArtifactSelectionAudit['selected'][number]['kind'],
    value: string,
    items: CatalogItem[],
    input: {
      score: number;
      source: 'explicit' | 'planner' | 'knowledge-fabric' | 'scorer';
      confidence: 'high' | 'medium' | 'low';
      reason: string;
      selector: 'id' | 'name';
    },
    selected: boolean = true,
  ): RuntimeArtifactSelectionAudit['selected'][number] {
    const item = items.find((entry) => (input.selector === 'id' ? entry.id === value : entry.name === value));
    return {
      kind,
      id: item?.id ?? value,
      name: item?.name ?? value,
      selected,
      score: Number(input.score.toFixed(2)),
      source: input.source,
      confidence: input.confidence,
      reason: input.reason,
    };
  }

  private pickCatalogNames(task: string, intent: AutonomyIntent, items: CatalogItem[], limit: number): string[] {
    return this.pickCatalogEntries(task, intent, items, limit).map((entry) => entry.item.name);
  }

  private pickCatalogEntries(task: string, intent: AutonomyIntent, items: CatalogItem[], limit: number): Array<{ item: CatalogItem; score: number }> {
    const keywords = extractKeywords(`${task} ${intent.taskType} ${intent.riskClass}`);
    return items
      .map((item) => ({
        item,
        score: scoreText(`${item.name}\n${item.body}`, keywords, intent),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.item.name.localeCompare(right.item.name))
      .slice(0, limit);
  }

  private scanCatalogHealth(selections: ResolvedSelections): RuntimeCatalogHealthSnapshot {
    const scanLocalDirectories = (relativeDirs: string[]) => {
      const scanned = relativeDirs.map((relativeDir) => {
        const localDirectory = path.join(this.repoRoot, relativeDir);
        if (!fs.existsSync(localDirectory)) {
          return { relativeDir, localDirectory, readable: false, files: 0, issues: [] as string[] };
        }
        try {
          const files = fs.readdirSync(localDirectory).filter((entry) => !entry.startsWith('.')).length;
          return { relativeDir, localDirectory, readable: true, files, issues: [] as string[] };
        } catch {
          return { relativeDir, localDirectory, readable: false, files: 0, issues: [`Unreadable ${relativeDir}`] };
        }
      });
      const readable = scanned.some((entry) => entry.readable);
      const existing = scanned.filter((entry) => fs.existsSync(entry.localDirectory));
      return {
        localDirectory: existing.find((entry) => entry.relativeDir.startsWith('.agents/'))?.localDirectory
          ?? existing[0]?.localDirectory
          ?? scanned[0]?.localDirectory,
        localDirectories: scanned.map((entry) => entry.localDirectory),
        readable,
        files: scanned.reduce((sum, entry) => sum + entry.files, 0),
        issues: readable
          ? scanned.flatMap((entry) => entry.issues)
          : [`Missing ${relativeDirs.join(' or ')}`],
      };
    };
    const skillsDir = scanLocalDirectories(['.agent/skills', '.agents/skills']);
    const workflowsDir = scanLocalDirectories(['.agent/workflows', '.agents/workflows']);
    const hooksDir = scanLocalDirectories(['.agent/hooks']);
    const automationsDir = scanLocalDirectories(['.agent/automations']);
    const specialistsAvailable = this.runtime.listSpecialists().length;
    const crewsAvailable = this.runtime.listCrews().length;
    const issues = [
      ...skillsDir.issues,
      ...workflowsDir.issues,
      ...hooksDir.issues,
      ...automationsDir.issues,
    ];
    const overall = issues.length > 0 ? 'degraded' : 'healthy';

    return {
      scannedAt: Date.now(),
      overall,
      issues,
      categories: {
        skills: {
          available: this.runtime.listSkills().length,
          usable: this.runtime.listSkills().length,
          selected: selections.skills.length,
          rejected: Math.max(0, this.runtime.listSkills().length - selections.skills.length),
          readable: skillsDir.readable,
          localDirectory: skillsDir.localDirectory,
          localDirectories: skillsDir.localDirectories,
          localOverrideFiles: skillsDir.files,
          issues: skillsDir.issues,
        },
        workflows: {
          available: this.runtime.listWorkflows().length,
          usable: this.runtime.listWorkflows().length,
          selected: selections.workflows.length,
          rejected: Math.max(0, this.runtime.listWorkflows().length - selections.workflows.length),
          readable: workflowsDir.readable,
          localDirectory: workflowsDir.localDirectory,
          localDirectories: workflowsDir.localDirectories,
          localOverrideFiles: workflowsDir.files,
          issues: workflowsDir.issues,
        },
        hooks: {
          available: this.runtime.listHooks().length,
          usable: this.runtime.listHooks().length,
          selected: selections.hooks.length,
          rejected: Math.max(0, this.runtime.listHooks().length - selections.hooks.length),
          readable: hooksDir.readable,
          localDirectory: hooksDir.localDirectory,
          localDirectories: hooksDir.localDirectories,
          localOverrideFiles: hooksDir.files,
          issues: hooksDir.issues,
        },
        automations: {
          available: this.runtime.listAutomations().length,
          usable: this.runtime.listAutomations().length,
          selected: selections.automations.length,
          rejected: Math.max(0, this.runtime.listAutomations().length - selections.automations.length),
          readable: automationsDir.readable,
          localDirectory: automationsDir.localDirectory,
          localDirectories: automationsDir.localDirectories,
          localOverrideFiles: automationsDir.files,
          issues: automationsDir.issues,
        },
        specialists: {
          available: specialistsAvailable,
          usable: specialistsAvailable,
          selected: selections.specialists.length,
          rejected: Math.max(0, specialistsAvailable - selections.specialists.length),
          readable: true,
          issues: [],
        },
        crews: {
          available: crewsAvailable,
          usable: crewsAvailable,
          selected: selections.crew ? 1 : 0,
          rejected: Math.max(0, crewsAvailable - (selections.crew ? 1 : 0)),
          readable: true,
          issues: [],
        },
      },
    };
  }

  private toSourceAwareTokenBudget(
    knowledgeFabric: KnowledgeFabricBundle,
    selectedFiles: string[],
    reason: string,
  ): RuntimeSourceAwareTokenBudgetSnapshot {
    return {
      applied: true,
      reason,
      totalBudget: knowledgeFabric.tokenBudget.totalBudget,
      bySource: knowledgeFabric.tokenBudget.bySource,
      byStage: knowledgeFabric.tokenBudget.byStage,
      dropped: knowledgeFabric.tokenBudget.dropped,
      dominantSource: knowledgeFabric.sourceMix.dominantSource,
    };
  }

  private toRagCandidateStatus(knowledgeFabric: KnowledgeFabricBundle): SessionBootstrapResult['ragCandidateStatus'] {
    const selectedChunks = knowledgeFabric.provenance.entries.filter((entry) => entry.sourceClass === 'rag' && entry.selected !== false).length;
    const droppedChunks = knowledgeFabric.tokenBudget.dropped.filter((entry) => entry.sourceClass === 'rag').length;
    return {
      attachedCollections: knowledgeFabric.rag.attachedCollections.length,
      retrievedChunks: knowledgeFabric.rag.hits.length,
      selectedChunks,
      droppedChunks,
      attachedNames: knowledgeFabric.rag.attachedCollections.map((collection) => collection.name),
    };
  }

  private toRagUsageSummary(
    knowledgeFabric: KnowledgeFabricBundle,
    usage: {
      usedInPlanner: boolean;
      usedInPacket: boolean;
      usedInRuntime: boolean;
    },
  ): RuntimeRagUsageSummary {
    const candidate = this.toRagCandidateStatus(knowledgeFabric);
    return {
      generatedAt: Date.now(),
      attachedCollections: candidate.attachedCollections,
      attachedNames: candidate.attachedNames,
      retrievedChunks: candidate.retrievedChunks,
      selectedChunks: candidate.selectedChunks,
      droppedChunks: candidate.droppedChunks,
      dominantSource: candidate.selectedChunks > 0 ? 'rag' : knowledgeFabric.sourceMix.dominantSource,
      usedInPlanner: usage.usedInPlanner,
      usedInPacket: usage.usedInPacket,
      usedInRuntime: usage.usedInRuntime,
    };
  }

  private buildTaskGraph(task: string, phases: string[], intent: AutonomyIntent): RuntimeTaskGraphSnapshot {
    const graphPhases: RuntimeTaskGraphSnapshot['phases'] = [
      {
        id: 'phase-plan',
        title: 'Plan and decompose',
        goal: task,
        kind: 'plan',
        branch: 0,
        dependsOn: [],
      },
      ...phases.map((phase, index) => ({
        id: `phase-${index + 1}`,
        title: shortLabel(phase, 56),
        goal: phase,
        kind: this.classifyPhaseKind(phase, intent, index, phases.length),
        branch: phases.length > 1 ? index + 1 : 1,
        dependsOn: index === 0 ? ['phase-plan'] : [`phase-${index}`],
      })),
      {
        id: 'phase-verify',
        title: 'Verify and govern',
        goal: `Verify ${task}`,
        kind: 'verify',
        branch: 0,
        dependsOn: phases.length > 0 ? [`phase-${phases.length}`] : ['phase-plan'],
      },
    ];
    const implementationPhases = graphPhases.filter((phase) => phase.kind === 'implement' || phase.kind === 'research');
    const independentBranches = Math.max(implementationPhases.length, phases.length > 1 ? phases.length : 1);
    return {
      generatedAt: Date.now(),
      summary: `${graphPhases.length} phases across ${independentBranches} branch(es).`,
      branchCount: new Set(graphPhases.map((phase) => phase.branch)).size,
      independentBranches,
      dominantKind: implementationPhases[0]?.kind ?? 'plan',
      phases: graphPhases,
    };
  }

  private buildWorkerPlan(
    workerCount: number,
    mode: RuntimeOrchestrationSnapshot['mode'],
    taskGraph: RuntimeTaskGraphSnapshot,
    knowledgeFabric: KnowledgeFabricBundle,
  ): RuntimeWorkerPlanSnapshot {
    const lanes: RuntimeWorkerPlanSnapshot['lanes'] = [
      {
        role: 'planner',
        count: 1,
        reason: 'Non-trivial autonomous runs always start with planner/decomposer authority.',
      },
      {
        role: 'coder',
        count: Math.max(2, Math.min(3, workerCount - 1)),
        reason: 'Runtime clamps to at least two coder workers for implementation pressure.',
      },
    ];
    if ((knowledgeFabric.rag.hits.length > 0) || (knowledgeFabric.patterns.selected.length > 0)) {
      lanes.push({
        role: 'researcher',
        count: 1,
        reason: 'RAG, patterns, or external context require a scout lane for grounding.',
      });
    }
    if (taskGraph.independentBranches >= 2) {
      lanes.push({
        role: 'integrator',
        count: 1,
        reason: 'Multiple branches need an integration lane before merge/apply.',
      });
      lanes.push({
        role: 'reviewer',
        count: 1,
        reason: 'Multi-branch work gets a distinct reviewer lane before completion.',
      });
    }
    if (mode === 'continuation-capable') {
      lanes.push({
        role: 'continuation',
        count: 1,
        reason: 'Continuation-capable mode keeps a bounded follow-up lane available.',
      });
    }
    const totalWorkers = lanes.reduce((sum, lane) => sum + lane.count, 0);
    return {
      generatedAt: Date.now(),
      mode,
      totalWorkers,
      continuationAllowed: mode === 'continuation-capable',
      summary: `${totalWorkers} planned worker lanes across ${taskGraph.independentBranches} branch(es).`,
      lanes,
    };
  }

  private buildArtifactOutcome(
    audit: RuntimeArtifactSelectionAudit,
    run: ExecutionRun,
  ): RuntimeArtifactOutcomeSnapshot {
    const activeNames = new Set([
      ...(run.activeSkills ?? []).map((skill) => skill.name),
      ...(run.activeWorkflows ?? []).map((workflow) => workflow.name),
      ...(run.activeHooks ?? []).map((hook) => hook.name),
      ...(run.activeAutomations ?? []).map((automation) => automation.name),
      ...(run.plannerState?.selectedSpecialists ?? []).map((specialist) => specialist.name),
      ...(run.plannerState?.selectedCrew ? [run.plannerState.selectedCrew.name] : []),
    ]);
    const verifiedWorkers = run.workerResults.filter((worker) => worker.verified).length;
    const outcomes = audit.selected.map((entry) => {
      const active = activeNames.has(entry.name);
      const helpful = active && (run.state === 'merged' || verifiedWorkers > 0);
      const harmful = run.state === 'failed' && entry.confidence === 'low';
      const redundant = !active && entry.score < 0.75;
      const outcome: RuntimeArtifactOutcomeSnapshot['outcomes'][number]['outcome'] = harmful
        ? 'harmful'
        : helpful
          ? 'helpful'
          : redundant
            ? 'redundant'
            : 'neutral';
      const score = outcome === 'helpful'
        ? 0.9
        : outcome === 'neutral'
          ? 0.5
          : outcome === 'redundant'
            ? 0.25
            : -0.35;
      const reason = harmful
        ? 'Low-confidence artifact stayed selected in a failed run.'
        : helpful
          ? 'Artifact stayed active through a verified or merged run.'
          : redundant
            ? 'Artifact was shortlisted but did not materially contribute at runtime.'
            : 'Artifact remained valid but the run evidence was mixed.';
      return {
        kind: entry.kind,
        id: entry.id,
        name: entry.name,
        outcome,
        score,
        reason,
      };
    });
    return {
      generatedAt: Date.now(),
      summary: `${outcomes.filter((entry) => entry.outcome === 'helpful').length} helpful · ${outcomes.filter((entry) => entry.outcome === 'redundant').length} redundant · ${outcomes.filter((entry) => entry.outcome === 'harmful').length} harmful`,
      outcomes,
    };
  }

  private mergeArtifactOutcomeHistory(
    existing: Record<string, number> | undefined,
    snapshot: RuntimeArtifactOutcomeSnapshot,
  ): Record<string, number> {
    const next = { ...(existing ?? {}) };
    for (const outcome of snapshot.outcomes) {
      const key = this.artifactHistoryKey(outcome.kind, outcome.id);
      next[key] = Number((((next[key] ?? 0) * 0.72) + outcome.score).toFixed(2));
    }
    return next;
  }

  private getArtifactHistoryScore(
    kind: RuntimeArtifactSelectionAudit['selected'][number]['kind'],
    id: string,
  ): number {
    const history = this.sessionState.artifactOutcomeHistory ?? {};
    return history[this.artifactHistoryKey(kind, id)] ?? 0;
  }

  private artifactHistoryKey(
    kind: RuntimeArtifactSelectionAudit['selected'][number]['kind'],
    id: string,
  ): string {
    return `${kind}:${id}`;
  }

  private classifyPhaseKind(
    phase: string,
    intent: AutonomyIntent,
    index: number,
    total: number,
  ): RuntimeTaskGraphSnapshot['phases'][number]['kind'] {
    const lower = phase.toLowerCase();
    if (/(research|investigate|explore|audit|inspect)/.test(lower)) return 'research';
    if (/(verify|test|review|check|validate)/.test(lower)) return 'verify';
    if (intent.taskType === 'release' && index === total - 1) return 'release';
    if (index === 0 && /(plan|decompose|scope)/.test(lower)) return 'plan';
    return 'implement';
  }

  private decideWorkers(
    requestedWorkers: number | undefined,
    plannedWorkers: number,
    phaseCount: number,
    intent: AutonomyIntent,
    repeatedFailures: number,
    knowledgeFabric?: KnowledgeFabricBundle,
  ): number {
    if (typeof requestedWorkers === 'number' && requestedWorkers > 0) {
      return Math.max(2, Math.min(7, requestedWorkers));
    }
    const baseline = Math.max(4, plannedWorkers + 1, phaseCount + 2);
    const failureBoost = repeatedFailures > 0 ? 1 : 0;
    const riskBoost = intent.riskClass === 'high' ? 1 : 0;
    const ragBoost = (knowledgeFabric?.rag.hits.length ?? 0) > 0 ? 1 : 0;
    const patternBoost = (knowledgeFabric?.patterns.selected.length ?? 0) > 1 ? 1 : 0;
    const multiPhaseBoost = phaseCount > 1 ? 1 : 0;
    return Math.max(2, Math.min(7, baseline + failureBoost + riskBoost + ragBoost + patternBoost + multiPhaseBoost));
  }

  private determineMode(intent: AutonomyIntent, phaseCount: number, workers: number): RuntimeOrchestrationSnapshot['mode'] {
    if (intent.taskType === 'release' || this.sessionState.repeatedFailures > 0) {
      return 'continuation-capable';
    }
    if (phaseCount > 1 || workers > 2 || intent.complexity >= 4) {
      return 'bounded-swarm';
    }
    return 'single-pass';
  }

  private generateOrchestrationPlan(task: string, intent: AutonomyIntent, workerPlan: any, instructionPacket: any): void {
    const planPath = path.join(this.repoRoot, '.nexus-prime', 'orchestration_plan.md');
    try {
      if (!fs.existsSync(path.dirname(planPath))) {
        fs.mkdirSync(path.dirname(planPath), { recursive: true });
      }
      
      const content = [
        '# Nexus Prime Orchestration Plan',
        `> Generated at ${new Date().toISOString()}`,
        '',
        '## 1. Intent & Routing',
        `- **Goal**: ${task}`,
        `- **Detected Intent**: \`${intent.taskType}\` (Risk: ${intent.riskClass}, Complexity: ${intent.complexity})`,
        `- **Mathematical Routing**: Applied strict TF-IDF/Vector heuristics weighted for the \`${intent.taskType}\` domain.`,
        '',
        '## 2. Swarm Topology (Parallel Sub-Agents)',
        `- **Total Agents Allocated**: ${workerPlan?.totalWorkers ?? 0}`,
        `- **Execution Mode**: ${workerPlan?.mode || 'default'}`,
        ...(workerPlan?.workers || []).map((w: any, idx: number) => `  - **Agent ${idx + 1}**: Uses isolated Git Worktree. Type: \`${w.type}\``),
        '',
        '## 3. POD Network & Resources',
        `- **Selected Crew**: ${instructionPacket.selectedCrew?.name ?? 'Default Engineering Crew'}`,
        `- **Injected Skills**: ${instructionPacket.selectedSkills.map((s: any) => s.name).join(', ') || 'None'}`,
        '- **Memory Bridges**: Active. Discoveries inside Phantom workers are tagged with `#shared` and synced to Cortex.',
        '',
        '## 4. Verification Check',
        "- Swarm consensus is **enforced**. The MergeOracle requires the Verifier sub-agent to strictly approve the Coder's git worktree diff before applying patches to origin.",
      ].join('\n');
      
      fs.writeFileSync(planPath, content, 'utf-8');
      
      // Auto-enhance standard Antigravity/Cursor implementation plans if explicitly enabled
      const igPlanPath = path.join(this.repoRoot, 'implementation_plan.md');
      const annotateImplementationPlan = process.env.NEXUS_ANNOTATE_IMPL_PLAN === 'true';
      if (!annotateImplementationPlan && fs.existsSync(igPlanPath)) {
          console.warn(
            '[orchestrator] Implicit implementation_plan.md mutation is disabled. ' +
            'Set NEXUS_ANNOTATE_IMPL_PLAN=true to re-enable the deprecated behavior.'
          );
      }
      if (annotateImplementationPlan && fs.existsSync(igPlanPath)) {
          let igPlan = fs.readFileSync(igPlanPath, 'utf8');
          if (!igPlan.includes('## Swarm Orchestration Details')) {
              igPlan += `\n\n## Swarm Orchestration Details\n*Nexus Prime has intercepted this plan and is enforcing multi-agent swarming.* See \`.nexus-prime/orchestration_plan.md\` for the parallel topology.\n`;
              fs.writeFileSync(igPlanPath, igPlan, 'utf8');
          }
      }
    } catch (error) {
       console.error(`[NEXUS] Failed to write orchestration_plan.md: `, error);
    }
  }
}

function extractKeywords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3)
    .filter((token) => !['with', 'from', 'this', 'that', 'then', 'also', 'into', 'about'].includes(token));
}

function scoreText(value: string, keywords: string[], intent?: AutonomyIntent): number {
  const lower = value.toLowerCase();
  
  // TF-IDF inspired logic: Term frequency with logarithmic normalization
  let score = keywords.reduce((sum, keyword) => {
    // Avoid regex errors with special characters in keyword
    const safeKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matchCount = (lower.match(new RegExp(`\\b${safeKeyword}\\b`, 'g')) || []).length;
    const tfScore = matchCount > 0 ? (1 + Math.log10(matchCount)) * 3 : 0;
    const partialScore = tfScore === 0 && lower.includes(keyword) ? 1.5 : 0;
    return sum + tfScore + partialScore;
  }, 0);

  // Math-based vector intent gravity
  if (intent) {
    if (intent.taskType === 'frontend' && (lower.includes('react') || lower.includes('ui') || lower.includes('css') || lower.includes('component'))) score += 15;
    if (intent.taskType === 'backend' && (lower.includes('api') || lower.includes('node') || lower.includes('sql') || lower.includes('server') || lower.includes('database'))) score += 15;
    if (intent.taskType === 'ai' && (lower.includes('prompt') || lower.includes('llm') || lower.includes('embedding') || lower.includes('model') || lower.includes('rag'))) score += 15;
    if ((intent.taskType === 'ops' || intent.taskType === 'infra' as any) && (lower.includes('docker') || lower.includes('ci/cd') || lower.includes('kubernetes') || lower.includes('deploy') || lower.includes('devops'))) score += 15;
    if (intent.taskType === 'pm' && (lower.includes('plan') || lower.includes('product') || lower.includes('jira') || lower.includes('roadmap') || lower.includes('requirements'))) score += 15;
    if (intent.taskType === 'marketing' && (lower.includes('seo') || lower.includes('copy') || lower.includes('marketing') || lower.includes('campaign'))) score += 15;
    if (intent.taskType === 'sales' && (lower.includes('lead') || lower.includes('pitch') || lower.includes('prospect'))) score += 15;
    if (intent.taskType === 'data' && (lower.includes('analysis') || lower.includes('query') || lower.includes('dashboard') || lower.includes('metrics'))) score += 15;
    if (intent.taskType === 'test' && (lower.includes('test') || lower.includes('jest') || lower.includes('e2e') || lower.includes('cypress') || lower.includes('qa'))) score += 15;

    const technicalIntent = ['bugfix', 'feature', 'review', 'refactor', 'test', 'frontend', 'backend', 'ai'].includes(intent.taskType);
    if (technicalIntent && /(marketing|seo|campaign|social|sales|gtm|product requirement|roadmap|pdlc)/.test(lower)) score -= 18;
    if (intent.taskType === 'backend' && /(landing page|copywriting|campaign|social|seo)/.test(lower)) score -= 22;
    if (intent.taskType === 'frontend' && /(seo|campaign|sales|gtm)/.test(lower) && !/(ui|component|layout|design system)/.test(lower)) score -= 12;
  }
  
  return score;
}

function scorePath(filePath: string, keywords: string[]): number {
  const normalized = filePath.toLowerCase();
  const baseScore = keywords.reduce((sum, keyword) => sum + (normalized.includes(keyword) ? 4 : 0), 0);
  if (normalized.includes('/src/')) return baseScore + 1;
  if (normalized.endsWith('.md')) return baseScore + 1;
  return baseScore;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function shortLabel(value: string, limit: number): string {
  const normalized = String(value ?? '').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export const createOrchestrator = (
  memory?: MemoryEngine,
  runtime?: SubAgentRuntime,
  clientRegistry?: ClientRegistry,
  sessionDNA?: SessionDNAManager,
  repoRoot?: string,
) => new OrchestratorEngine({ memory, runtime, clientRegistry, sessionDNA, repoRoot });
