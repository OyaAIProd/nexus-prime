import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { nexusEventBus, type NexusEvent, type NexusEventType } from '../engines/event-bus.js';
import type { Adapter } from '../core/types.js';
import type { MemoryEngine } from '../engines/memory.js';
import { podNetwork } from '../engines/pod-network.js';
import { ClientRegistry } from '../engines/client-registry.js';
import type { SubAgentRuntime } from '../phantom/runtime.js';
import { RuntimeRegistry, resolveNexusStateDir } from '../engines/runtime-registry.js';
import type { OrchestratorEngine } from '../engines/orchestrator.js';
import { buildFeatureRegistry } from '../engines/feature-registry.js';
import { RepoTreeGenerator } from '../engines/repo-tree.js';
import type { SynapseRuntime } from '../synapse/index.js';
import type { ArchitectsRuntime } from '../architects/index.js';
import { NexusLayerAdapter } from '../engines/nexus-layer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = process.env.NEXUS_DASHBOARD_HOST || '127.0.0.1';
const DEFAULT_PORT = parseInt(process.env.NEXUS_DASHBOARD_PORT || '3377', 10);
const MAX_PORT_SCAN = 24;
const DASHBOARD_API_VERSION = '4';
const DASHBOARD_SCHEMA_VERSION = 1;
const CORE_CAPABILITIES = {
    runs: true,
    memory: true,
    pod: true,
    clients: true,
    events: true,
    stream: true,
    tokens: true,
    tokenSources: true,
    lifetimeTokens: true,
} as const;

const OPTIONAL_CAPABILITIES = {
    hooks: true,
    automations: true,
    federation: true,
    specialists: true,
    crews: true,
    planner: true,
    orchestration: true,
    clientPrimary: true,
    instructionPacket: true,
    orchestrationLedger: true,
    knowledgeFabric: true,
    ragCollections: true,
    patterns: true,
    modelTiers: true,
    workerPlan: true,
    artifactOutcomes: true,
    memoryTrace: true,
    memoryShared: true,
    worktreeHealth: true,
    featureRegistry: true,
    synapse: true,
    architects: true,
    dashboardSummary: true,
    dashboardSurfaces: true,
    nexusLayer: true,
} as const;

interface DashboardServerOptions {
    runtimeProvider?: () => SubAgentRuntime | undefined;
    orchestratorProvider?: () => OrchestratorEngine | undefined;
    memoryProvider?: () => MemoryEngine | undefined;
    adaptersProvider?: () => Adapter[];
    clientRegistryProvider?: () => ClientRegistry | undefined;
    synapseProvider?: () => SynapseRuntime | undefined;
    architectsProvider?: () => ArchitectsRuntime | undefined;
    repoRoot?: string;
}

interface DashboardEventCard {
    id: string;
    type: NexusEventType;
    title: string;
    source: string;
    time: number;
    severity: 'good' | 'info' | 'warn' | 'bad';
    category: 'memory' | 'tokens' | 'runtime' | 'pod' | 'skills' | 'workflows' | 'clients' | 'system' | 'hooks' | 'automations' | 'shield' | 'federation';
    summary: string;
    payload: unknown;
}

interface DashboardCompatibilityProbe {
    status: 'free' | 'compatible' | 'incompatible';
    url: string;
    health?: DashboardHealthResponse;
    reason?: string;
}

interface DashboardProbeResponse {
    statusCode: number;
    body: string;
}

interface DashboardHealthResponse {
    dashboardApiVersion: string;
    capabilities: Record<string, boolean>;
    dashboardUrl: string | null;
    dashboardMode: 'idle' | 'bound' | 'reused';
    connection: unknown;
    runtime: unknown;
    memory: unknown;
    pod: unknown;
    clients: unknown;
    release: unknown;
    docs: unknown;
    ci: unknown;
}

interface CachedResponse<T> {
    expiresAt: number;
    value?: T;
    refresh?: Promise<T>;
}

type DashboardSurfaceMode = 'operate' | 'memory' | 'runs' | 'assets' | 'trust';

export class DashboardServer {
    private server: http.Server;
    private cachedDashboardHtml: string | null = null;
    private clients: Set<http.ServerResponse> = new Set();
    private unsubscribeBus: (() => void) | null = null;
    private runtimeProvider?: () => SubAgentRuntime | undefined;
    private orchestratorProvider?: () => OrchestratorEngine | undefined;
    private memoryProvider?: () => MemoryEngine | undefined;
    private adaptersProvider?: () => Adapter[];
    private clientRegistryProvider?: () => ClientRegistry | undefined;
    private synapseProvider?: () => SynapseRuntime | undefined;
    private architectsProvider?: () => ArchitectsRuntime | undefined;
    private repoRoot: string;
    private runtimeRegistry: RuntimeRegistry;
    private dashboardUrl: string | null = null;
    private dashboardMode: 'idle' | 'bound' | 'reused' = 'idle';
    private activePort: number | null = null;
    private started = false;
    private initializePromise: Promise<void> | null = null;
    private endpointCache = new Map<string, CachedResponse<unknown>>();
    private repoTreeGenerator: RepoTreeGenerator;
    private gitUser: string;

    constructor(options: DashboardServerOptions = {}) {
        this.runtimeProvider = options.runtimeProvider;
        this.orchestratorProvider = options.orchestratorProvider;
        this.memoryProvider = options.memoryProvider;
        this.adaptersProvider = options.adaptersProvider;
        this.clientRegistryProvider = options.clientRegistryProvider;
        this.synapseProvider = options.synapseProvider;
        this.architectsProvider = options.architectsProvider;
        this.repoRoot = options.repoRoot ?? process.cwd();
        this.runtimeRegistry = new RuntimeRegistry();
        this.repoTreeGenerator = new RepoTreeGenerator(this.repoRoot);
        this.gitUser = process.env.GIT_AUTHOR_NAME || process.env.GIT_COMMITTER_NAME || '';
        this.server = http.createServer((req, res) => {
            void this.requestHandler(req, res);
        });
        this.server.on('error', (error: NodeJS.ErrnoException) => {
            if (this.dashboardMode === 'bound') {
                console.error('[Dashboard] Server error:', error.message);
            }
        });
    }

    start(): void {
        if (process.env.NEXUS_DASHBOARD_DISABLED === '1') {
            console.error('[Dashboard] Disabled by NEXUS_DASHBOARD_DISABLED=1');
            return;
        }
        if (this.started) {
            return;
        }
        this.started = true;
        this.initializePromise = this.initialize().catch((error) => {
            this.started = false;
            this.dashboardMode = 'idle';
            this.dashboardUrl = null;
            this.activePort = null;
            console.error('[Dashboard] Failed to start dashboard:', error instanceof Error ? error.message : String(error));
        });
    }

    stop(): void {
        if (this.unsubscribeBus) {
            this.unsubscribeBus();
            this.unsubscribeBus = null;
        }

        if (this.dashboardMode === 'bound') {
            nexusEventBus.stopFilePolling();

            for (const res of this.clients) {
                res.end();
            }
            this.clients.clear();

            this.server.close();
        }

        this.dashboardMode = 'idle';
        this.dashboardUrl = null;
        this.activePort = null;
        this.started = false;
    }

    getAddress(): string | null {
        return this.dashboardUrl;
    }

    private migrateDashboardState(): void {
        const statePath = path.join(resolveNexusStateDir(), 'dashboard-state.json');
        if (!fs.existsSync(path.dirname(statePath))) {
            try {
                fs.mkdirSync(path.dirname(statePath), { recursive: true });
            } catch (err: any) {
                console.error('[Dashboard] Cannot create state dir:', err?.message);
                return;
            }
        }
        
        let state: any = { schemaVersion: 0 };
        if (fs.existsSync(statePath)) {
            try {
                state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            } catch {
                // ignore
            }
        }

        if ((state.schemaVersion || 0) < DASHBOARD_SCHEMA_VERSION) {
            console.error(`[Dashboard] Migrating state from v${state.schemaVersion || 0} to v${DASHBOARD_SCHEMA_VERSION}`);
            state.schemaVersion = DASHBOARD_SCHEMA_VERSION;
            try {
                fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
            } catch (err: any) {
                console.error('[Dashboard] Cannot write state migration:', err?.message);
            }
        }
    }

    private async initialize(): Promise<void> {
        this.migrateDashboardState();

        const targetPort = process.env.NEXUS_DASHBOARD_PORT ? parseInt(process.env.NEXUS_DASHBOARD_PORT, 10) : DEFAULT_PORT;
        const probe = await this.probeDashboard(targetPort);

        if (probe.status === 'compatible') {
            this.dashboardMode = 'reused';
            this.dashboardUrl = probe.url;
            this.activePort = targetPort;
            console.error(`[Dashboard] Reusing compatible dashboard at ${probe.url}`);
            return;
        }

        const startPort = probe.status === 'incompatible' ? targetPort + 1 : targetPort;
        const fallbackPort = await this.bindFirstAvailablePort(startPort, targetPort + MAX_PORT_SCAN);

        this.dashboardMode = 'bound';
        this.activePort = fallbackPort;
        this.dashboardUrl = this.buildUrl(fallbackPort);
        this.unsubscribeBus = nexusEventBus.onEvent((event) => this.broadcast(event));
        nexusEventBus.startFilePolling();

        if (probe.status === 'incompatible') {
            console.error(`[Dashboard] Incompatible dashboard detected at ${probe.url} (${probe.reason || 'missing compatibility contract'}). New dashboard started at ${this.dashboardUrl}`);
            return;
        }

        console.error(`[Dashboard] Topology console listening at ${this.dashboardUrl}`);
    }

    private async requestHandler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
      try {
        const url = new URL(req.url || '/', this.dashboardUrl ?? this.buildUrl(this.activePort ?? DEFAULT_PORT));

        if (req.method === 'OPTIONS') {
            this.respondOptions(res);
            return;
        }

        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
            this.serveDashboard(res);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/stream') {
            this.serveSSE(req, res);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/runs') {
            const limit = parseInt(url.searchParams.get('limit') || '20', 10);
            this.respondJson(res, this.getRuntime()?.listRuns(limit) ?? []);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/runtimes') {
            this.respondJson(res, this.runtimeRegistry.list());
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/usage') {
            this.respondJson(res, this.collectUsageSnapshot(url));
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/orchestration/session') {
            const snapshot = this.resolveRuntimeSnapshot(url);
            const orchestrator = this.getOrchestrator();
            this.respondJson(res, snapshot?.orchestration ?? orchestrator?.getSessionState() ?? {});
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/orchestration/ledger') {
            const snapshot = this.resolveRuntimeSnapshot(url);
            this.respondJson(res, snapshot?.executionLedger ?? this.getRuntime()?.getExecutionLedger() ?? {});
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/orchestration/worker-plan') {
            const snapshot = this.resolveRuntimeSnapshot(url);
            this.respondJson(res, snapshot?.workerPlan ?? this.getRuntime()?.getUsageSnapshot()?.workerPlan ?? {});
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/orchestration/artifact-outcomes') {
            const snapshot = this.resolveRuntimeSnapshot(url);
            this.respondJson(res, snapshot?.artifactOutcome ?? this.getRuntime()?.getUsageSnapshot()?.artifactOutcome ?? {});
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/instruction-packet') {
            const snapshot = this.resolveRuntimeSnapshot(url);
            this.respondJson(res, snapshot?.instructionPacket ?? this.getRuntime()?.getInstructionPacket() ?? {});
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/knowledge-fabric/session') {
            const snapshot = this.resolveRuntimeSnapshot(url);
            const orchestrator = this.getOrchestrator();
            this.respondJson(res, snapshot?.knowledgeFabric ?? orchestrator?.getKnowledgeFabricSnapshot?.() ?? {});
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/knowledge-fabric/provenance') {
            const snapshot = this.resolveRuntimeSnapshot(url);
            const orchestrator = this.getOrchestrator();
            this.respondJson(res, snapshot?.knowledgeFabric?.provenance ?? orchestrator?.getKnowledgeFabricProvenance?.() ?? { entries: [] });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/worktree-health') {
            const snapshot = this.resolveRuntimeSnapshot(url);
            this.respondJson(res, snapshot?.worktreeHealth ?? this.getRuntime()?.getUsageSnapshot()?.worktreeHealth ?? {});
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/feature-registry') {
            this.respondJson(res, await this.getCachedValue('feature-registry', 30_000, () => Promise.resolve(buildFeatureRegistry(this.repoRoot))));
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/synapse/teams') {
            this.respondJson(res, this.getSynapse()?.getStrikeTeamStatus() ?? []);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/synapse/health') {
            this.respondJson(res, this.getSynapse()?.getOperativeHealth() ?? []);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/synapse/approvals') {
            this.respondJson(res, this.getSynapse()?.getPendingApprovals() ?? []);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/architects/dispatch') {
            this.respondJson(res, this.getArchitects()?.getDispatchStatus() ?? {});
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/architects/escalations') {
            this.respondJson(res, this.getArchitects()?.getWardEscalations() ?? []);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/architects/worklist') {
            const worklistId = url.searchParams.get('worklistId');
            if (!worklistId) {
                this.respondJson(res, { error: 'worklistId-required' }, 400);
                return;
            }
            this.respondJson(res, this.getArchitects()?.getWorklist(worklistId) ?? { error: 'architects-unavailable' });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/tokens/summary') {
            const snapshot = this.resolveRuntimeSnapshot(url);
            this.respondJson(res, snapshot?.tokens ?? this.getRuntime()?.getTokenTelemetrySummary() ?? {});
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/tokens/by-source') {
            const snapshot = this.resolveRuntimeSnapshot(url);
            this.respondJson(res, snapshot?.tokens?.bySourceClass ?? this.getRuntime()?.getTokenTelemetrySummary()?.bySourceClass ?? {});
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/tokens/timeline') {
            const limit = parseInt(url.searchParams.get('limit') || '20', 10);
            const snapshot = this.resolveRuntimeSnapshot(url);
            const timeline = snapshot?.tokens?.timeline ?? this.getRuntime()?.getTokenTelemetryTimeline(limit) ?? [];
            this.respondJson(res, timeline.slice(0, Math.max(1, limit)));
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/tokens/lifetime') {
            try {
                const { readLifetimeTokens } = await import('../engines/lifetime-tokens.js');
                const record = readLifetimeTokens();
                this.respondJson(res, { ok: true, data: record });
            } catch (err: any) {
                this.respondJson(res, { ok: false, error: err?.message ?? 'Failed to read lifetime tokens' });
            }
            return;
        }

        if (req.method === 'GET' && url.pathname.startsWith('/api/tokens/runs/')) {
            const runId = decodeURIComponent(url.pathname.replace('/api/tokens/runs/', ''));
            const snapshot = this.resolveRuntimeSnapshot(url);
            const entry = this.getRuntime()?.getRuntimeId() === snapshot?.runtimeId
                ? this.getRuntime()?.getTokenTelemetryForRun(runId)
                : snapshot?.tokens?.timeline?.find((item) => item.runId === runId);
            this.respondJson(res, entry ?? { error: 'run-token-telemetry-not-found', runId }, entry ? 200 : 404);
            return;
        }

        if (req.method === 'GET' && url.pathname.startsWith('/api/runs/')) {
            const runId = decodeURIComponent(url.pathname.replace('/api/runs/', ''));
            const run = this.getRuntime()?.getRun(runId);
            this.respondJson(res, run ?? { error: 'run-not-found', runId }, run ? 200 : 404);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/skills') {
            this.respondJson(res, this.getRuntime()?.listSkills() ?? []);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/workflows') {
            this.respondJson(res, this.getRuntime()?.listWorkflows() ?? []);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/hooks') {
            this.respondJson(res, this.getRuntime()?.listHooks() ?? []);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/automations') {
            this.respondJson(res, this.getRuntime()?.listAutomations() ?? []);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/rag/collections') {
            this.respondJson(res, this.getOrchestrator()?.listRagCollections?.() ?? []);
            return;
        }

        if (req.method === 'GET' && url.pathname.startsWith('/api/rag/collections/')) {
            const collectionId = decodeURIComponent(url.pathname.replace('/api/rag/collections/', ''));
            const collection = this.getOrchestrator()?.getRagCollection?.(collectionId);
            this.respondJson(res, collection ?? { error: 'rag-collection-not-found', collectionId }, collection ? 200 : 404);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/patterns/search') {
            const query = url.searchParams.get('q') ?? '';
            const limit = parseInt(url.searchParams.get('limit') || '8', 10);
            const orchestrator = this.getOrchestrator();
            const results = query.trim()
                ? orchestrator?.searchPatterns?.(query, limit) ?? []
                : (orchestrator?.listPatterns?.() ?? []).slice(0, Math.max(1, limit));
            this.respondJson(res, results);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/models/tiers') {
            const snapshot = this.resolveRuntimeSnapshot(url);
            const orchestrator = this.getOrchestrator();
            this.respondJson(res, snapshot?.knowledgeFabric
                ? {
                    policy: snapshot.knowledgeFabric.modelTierPolicy,
                    trace: snapshot.knowledgeFabric.modelTierTrace,
                }
                : orchestrator?.getModelTierTrace?.() ?? { trace: [] });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/specialists') {
            this.respondJson(res, (this.getRuntime()?.listSpecialists() ?? []).map((specialist) => ({
                specialistId: specialist.specialistId,
                name: specialist.name,
                division: specialist.division,
                description: specialist.description,
                authority: specialist.authority,
                domains: specialist.domains,
                tools: specialist.tools,
                mission: specialist.mission,
                workflow: specialist.workflow,
                deliverables: specialist.deliverables,
                communicationStyle: specialist.communicationStyle,
                successMetrics: specialist.successMetrics,
                recommendedSkills: specialist.recommendedSkills,
                recommendedWorkflows: specialist.recommendedWorkflows,
                sourcePath: specialist.sourcePath,
            })));
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/crews') {
            this.respondJson(res, this.getRuntime()?.listCrews() ?? []);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/backends') {
            this.respondJson(res, this.getRuntime()?.getBackendCatalog() ?? {});
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/health') {
            this.respondJson(res, await this.getCachedValue('health', 15_000, () => this.collectHealth()));
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/dashboard/summary') {
            const runtimeId = url.searchParams.get('runtimeId') || 'default';
            this.respondJson(res, await this.getCachedValue(`dashboard-summary:${runtimeId}`, 5_000, () => this.collectDashboardSummary(url)));
            return;
        }

        if (req.method === 'GET' && url.pathname.startsWith('/api/dashboard/surface/')) {
            const surface = decodeURIComponent(url.pathname.replace('/api/dashboard/surface/', '')) as DashboardSurfaceMode;
            this.respondJson(res, await this.collectDashboardSurface(surface, url));
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/dashboard/entity') {
            const kind = url.searchParams.get('kind') ?? '';
            const id = url.searchParams.get('id') ?? '';
            if (!kind || !id) {
                this.respondJson(res, { error: 'kind-and-id-required' }, 400);
                return;
            }
            const entity = this.resolveDashboardEntity(kind, id, url);
            this.respondJson(res, entity ?? { error: 'dashboard-entity-not-found', kind, id }, entity ? 200 : 404);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/memory') {
            const limit = parseInt(url.searchParams.get('limit') || '40', 10);
            const tier = url.searchParams.get('tier') ?? undefined;
            const tag = url.searchParams.get('tag') ?? undefined;
            const linkedType = url.searchParams.get('linkedType') ?? undefined;
            const recencyMs = url.searchParams.get('recencyMs');
            const showPhantom = url.searchParams.get('showPhantom') === 'true';
            const lane = url.searchParams.get('lane') ?? undefined;
            const repoId = url.searchParams.get('repoId') ?? undefined;
            const workspaceId = url.searchParams.get('workspaceId') ?? undefined;
            const projectId = url.searchParams.get('projectId') ?? undefined;
            const includeHidden = url.searchParams.get('includeHidden') === 'true';
            this.respondJson(res, this.listDashboardMemories({
                limit,
                tier: tier as 'prefrontal' | 'hippocampus' | 'cortex' | undefined,
                tag,
                linkedType: linkedType as 'session' | 'run' | 'skill' | 'workflow' | undefined,
                recencyMs: recencyMs ? parseInt(recencyMs, 10) : undefined,
                showPhantom,
                lane: lane as 'profile' | 'workspace' | 'shared' | 'inbox' | undefined,
                repoId,
                workspaceId,
                projectId,
                includeHidden,
            }));
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/memory/audit') {
            const limit = parseInt(url.searchParams.get('limit') || '80', 10);
            this.respondJson(res, this.getRuntime()?.auditMemory(limit) ?? { scanned: 0, quarantined: [], findings: [] });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/memory/health') {
            this.respondJson(res, this.getRuntime()?.getMemoryHealth() ?? {
                generatedAt: Date.now(),
                total: 0,
                active: 0,
                quarantined: 0,
                scrap: 0,
                promoted: 0,
                shared: 0,
                topTags: [],
            });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/memory/shared') {
            const snapshot = this.resolveRuntimeSnapshot(url);
            const runtime = this.getRuntime();
            const shared = snapshot?.runtimeId && runtime?.getRuntimeId() === snapshot.runtimeId
                ? runtime.getSharedMemorySnapshot?.(12)
                : [];
            this.respondJson(res, shared ?? []);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/memory/trace') {
            const id = url.searchParams.get('id') ?? '';
            const snapshot = this.resolveRuntimeSnapshot(url);
            const runtime = this.getRuntime();
            const traced = snapshot?.runtimeId && runtime?.getRuntimeId() === snapshot.runtimeId
                ? runtime.traceMemory?.(id)
                : this.getMemory()?.trace?.(id);
            this.respondJson(res, traced ?? { error: 'memory-trace-not-found', id }, traced ? 200 : 404);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/memory/quarantine') {
            const limit = parseInt(url.searchParams.get('limit') || '40', 10);
            this.respondJson(res, this.getRuntime()?.listMemoryQuarantine(limit) ?? []);
            return;
        }

        if (req.method === 'GET' && url.pathname.startsWith('/api/memory/') && url.pathname.endsWith('/network')) {
            const id = decodeURIComponent(url.pathname.replace('/api/memory/', '').replace('/network', '').replace(/\/$/, ''));
            const depth = parseInt(url.searchParams.get('depth') || '2', 10);
            const limit = parseInt(url.searchParams.get('limit') || '18', 10);
            const memory = this.getMemory();
            this.respondJson(res, memory?.getNetworkSnapshot(id, depth, limit) ?? { focusId: id, nodes: [], links: [] });
            return;
        }

        if (req.method === 'GET' && url.pathname.startsWith('/api/memory/')) {
            const id = decodeURIComponent(url.pathname.replace('/api/memory/', ''));
            const memory = this.getMemory();
            const detail = memory?.trace?.(id) ?? memory?.getDetail(id);
            this.respondJson(res, detail ?? { error: 'memory-not-found', id }, detail ? 200 : 404);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/pod') {
            const limit = parseInt(url.searchParams.get('limit') || '40', 10);
            this.respondJson(res, podNetwork.getDashboardSnapshot(limit));
            return;
        }

        if (req.method === 'GET' && url.pathname.startsWith('/api/pod/')) {
            const workerId = decodeURIComponent(url.pathname.replace('/api/pod/', ''));
            const limit = parseInt(url.searchParams.get('limit') || '20', 10);
            this.respondJson(res, podNetwork.getWorker(workerId, limit));
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/clients') {
            const snapshot = this.resolveRuntimeSnapshot(url);
            this.respondJson(res, snapshot?.clients?.detected?.length
                ? snapshot.clients.detected
                : this.getClientRegistry()?.listClients(this.getAdapters()) ?? []);
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/clients/primary') {
            const snapshot = this.resolveRuntimeSnapshot(url);
            this.respondJson(res, snapshot?.clients?.primary ?? this.getClientRegistry()?.getPrimaryClient(this.getAdapters()) ?? {});
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/federation') {
            this.respondJson(res, this.getRuntime()?.getNetworkStatus() ?? {});
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/repo-tree') {
            this.respondJson(res, await this.getCachedValue('repo-tree', 45_000, () => Promise.resolve(this.repoTreeGenerator.generate())));
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/events') {
            const category = url.searchParams.get('category');
            const type = url.searchParams.get('type');
            const limit = parseInt(url.searchParams.get('limit') || '80', 10);
            const events = this.getEventCards()
                .filter((event) => !category || event.category === category)
                .filter((event) => !type || event.type === type)
                .slice(0, Math.max(limit, 1));
            this.respondJson(res, events);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/rag/collections') {
            const body = await this.readJsonBody(req);
            const orchestrator = this.getOrchestrator();
            if (!orchestrator) {
                this.respondJson(res, { error: 'orchestrator-unavailable' }, 503);
                return;
            }
            if (!String(body.name ?? '').trim()) {
                this.respondJson(res, { error: 'name-required' }, 400);
                return;
            }
            const collection = orchestrator.createRagCollection({
                name: String(body.name),
                description: body.description ? String(body.description) : undefined,
                tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
                scope: body.scope === 'project' ? 'project' : 'session',
            });
            this.respondJson(res, collection, 201);
            return;
        }

        if (req.method === 'POST' && /\/api\/rag\/collections\/[^/]+\/ingest$/.test(url.pathname)) {
            const collectionId = decodeURIComponent(url.pathname.split('/')[4] || '');
            const body = await this.readJsonBody(req);
            const orchestrator = this.getOrchestrator();
            if (!orchestrator) {
                this.respondJson(res, { error: 'orchestrator-unavailable' }, 503);
                return;
            }
            const inputs = Array.isArray(body.inputs)
                ? body.inputs.map((entry: any) => ({
                    filePath: (() => {
                        if (!entry?.filePath) return undefined;
                        const abs = path.resolve(String(entry.filePath));
                        return abs.startsWith(process.cwd() + path.sep) || abs === process.cwd()
                            ? String(entry.filePath) : undefined;
                    })(),
                    url: entry?.url ? String(entry.url) : undefined,
                    text: entry?.text ? String(entry.text) : undefined,
                    label: entry?.label ? String(entry.label) : undefined,
                    tags: Array.isArray(entry?.tags) ? entry.tags.map(String) : [],
                }))
                : [];
            const result = await orchestrator.ingestRagCollection(collectionId, inputs);
            this.respondJson(res, result);
            return;
        }

        if (req.method === 'POST' && /\/api\/rag\/collections\/[^/]+\/attach$/.test(url.pathname)) {
            const collectionId = decodeURIComponent(url.pathname.split('/')[4] || '');
            const orchestrator = this.getOrchestrator();
            if (!orchestrator) {
                this.respondJson(res, { error: 'orchestrator-unavailable' }, 503);
                return;
            }
            this.respondJson(res, orchestrator.attachRagCollection(collectionId));
            return;
        }

        if (req.method === 'POST' && /\/api\/rag\/collections\/[^/]+\/detach$/.test(url.pathname)) {
            const collectionId = decodeURIComponent(url.pathname.split('/')[4] || '');
            const orchestrator = this.getOrchestrator();
            if (!orchestrator) {
                this.respondJson(res, { error: 'orchestrator-unavailable' }, 503);
                return;
            }
            this.respondJson(res, orchestrator.detachRagCollection(collectionId));
            return;
        }

        if (req.method === 'DELETE' && url.pathname.startsWith('/api/rag/collections/')) {
            const collectionId = decodeURIComponent(url.pathname.replace('/api/rag/collections/', ''));
            const orchestrator = this.getOrchestrator();
            if (!orchestrator) {
                this.respondJson(res, { error: 'orchestrator-unavailable' }, 503);
                return;
            }
            const removed = orchestrator.deleteRagCollection(collectionId);
            this.respondJson(res, removed ? { ok: true, collectionId } : { error: 'rag-collection-not-found', collectionId }, removed ? 200 : 404);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/skills/deploy') {
            const body = await this.readJsonBody(req);
            const runtime = this.getRuntime();
            const deployed = runtime?.deploySkill(String(body.skillId), body.scope);
            if (deployed) {
                nexusEventBus.emit('skill.deploy', {
                    skillId: deployed.skillId,
                    scope: deployed.scope,
                    status: deployed.rolloutStatus,
                });
            }
            this.respondJson(res, deployed ?? { error: 'skill-not-found' }, deployed ? 200 : 404);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/skills/revoke') {
            const body = await this.readJsonBody(req);
            const runtime = this.getRuntime();
            const revoked = runtime?.revokeSkill(String(body.skillId));
            if (revoked) {
                nexusEventBus.emit('skill.revoke', {
                    skillId: revoked.skillId,
                    status: revoked.rolloutStatus,
                });
            }
            this.respondJson(res, revoked ?? { error: 'skill-not-found' }, revoked ? 200 : 404);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/skills/register') {
            const body = await this.readJsonBody(req);
            const runtime = this.getRuntime();
            if (!runtime) {
                this.respondJson(res, { error: 'runtime-unavailable' }, 503);
                return;
            }
            try {
                const riskClass = (['read', 'orchestrate', 'mutate'].includes(body.riskClass) ? body.riskClass : 'orchestrate') as 'read' | 'orchestrate' | 'mutate';
                const scope = (['session', 'worker', 'global'].includes(body.scope) ? body.scope : 'session') as 'session' | 'worker' | 'global';
                const skill = runtime.generateSkill({
                    name: String(body.name || 'unnamed-skill'),
                    instructions: String(body.instructions || ''),
                    riskClass,
                    scope,
                });
                nexusEventBus.emit('skill.register', {
                    name: skill.name,
                    id: skill.skillId,
                });
                this.respondJson(res, skill);
            } catch (err: any) {
                this.respondJson(res, { error: err.message || 'register-failed' }, 400);
            }
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/skills/seed') {
            const runtime = this.getRuntime();
            if (!runtime) {
                this.respondJson(res, { error: 'runtime-unavailable' }, 503);
                return;
            }
            this.respondJson(res, {
                mode: 'canonical-runtime',
                message: 'Bundled runtime assets are already loaded; dashboard-local seeding is disabled.',
                seeded: [],
                summary: {
                    skills: runtime.listSkills().length,
                    workflows: runtime.listWorkflows().length,
                    hooks: runtime.listHooks().length,
                    automations: runtime.listAutomations().length,
                },
            });
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/workflows/deploy') {
            const body = await this.readJsonBody(req);
            const runtime = this.getRuntime();
            const deployed = runtime?.deployWorkflow(String(body.workflowId), body.scope);
            if (deployed) {
                nexusEventBus.emit('workflow.deploy', {
                    workflowId: deployed.workflowId,
                    scope: deployed.scope,
                    status: deployed.rolloutStatus,
                });
            }
            this.respondJson(res, deployed ?? { error: 'workflow-not-found' }, deployed ? 200 : 404);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/hooks/deploy') {
            const body = await this.readJsonBody(req);
            const runtime = this.getRuntime();
            const deployed = runtime?.deployHook(String(body.hookId), body.scope);
            if (deployed) {
                nexusEventBus.emit('hook.deploy', {
                    hookId: deployed.hookId,
                    scope: deployed.scope,
                    status: deployed.rolloutStatus,
                });
            }
            this.respondJson(res, deployed ?? { error: 'hook-not-found' }, deployed ? 200 : 404);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/hooks/revoke') {
            const body = await this.readJsonBody(req);
            const runtime = this.getRuntime();
            const revoked = runtime?.revokeHook(String(body.hookId));
            if (revoked) {
                nexusEventBus.emit('hook.revoke', {
                    hookId: revoked.hookId,
                    status: revoked.rolloutStatus,
                });
            }
            this.respondJson(res, revoked ?? { error: 'hook-not-found' }, revoked ? 200 : 404);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/workflows/run') {
            const body = await this.readJsonBody(req);
            const runtime = this.getRuntime();
            if (!runtime) {
                this.respondJson(res, { error: 'runtime-unavailable' }, 503);
                return;
            }
            try {
                const run = await runtime.runWorkflow(String(body.workflowId), body.goal ? String(body.goal) : undefined);
                nexusEventBus.emit('workflow.run', {
                    workflowId: String(body.workflowId),
                    runId: run.runId,
                    status: run.state,
                });
                this.respondJson(res, run);
            } catch (error) {
                this.respondJson(res, { error: error instanceof Error ? error.message : 'workflow-run-failed' }, 400);
            }
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/runtime/execute') {
            const body = await this.readJsonBody(req);
            const orchestrator = this.getOrchestrator();
            if (!orchestrator) {
                this.respondJson(res, { error: 'orchestrator-unavailable' }, 503);
                return;
            }
            if (!body.goal || typeof body.goal !== 'string') {
                this.respondJson(res, { error: 'goal-required' }, 400);
                return;
            }
            const run = await orchestrator.orchestrate(String(body.goal), body as Parameters<SubAgentRuntime['run']>[0]);
            nexusEventBus.emit('dashboard.action', {
                action: 'runtime.execute',
                status: run.state,
                target: run.runId,
            });
            this.respondJson(res, run, 201);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/runtime/plan') {
            const body = await this.readJsonBody(req);
            const runtime = this.getRuntime();
            if (!runtime) {
                this.respondJson(res, { error: 'runtime-unavailable' }, 503);
                return;
            }
            if (!body.goal || typeof body.goal !== 'string') {
                this.respondJson(res, { error: 'goal-required' }, 400);
                return;
            }
            const plan = await runtime.planExecution(body as Parameters<SubAgentRuntime['planExecution']>[0]);
            nexusEventBus.emit('dashboard.action', {
                action: 'runtime.plan',
                status: 'ready',
                target: plan.selectedCrew?.crewId,
            });
            this.respondJson(res, plan);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/automations/deploy') {
            const body = await this.readJsonBody(req);
            const runtime = this.getRuntime();
            const deployed = runtime?.deployAutomation(String(body.automationId), body.scope);
            if (deployed) {
                nexusEventBus.emit('automation.deploy', {
                    automationId: deployed.automationId,
                    scope: deployed.scope,
                    status: deployed.rolloutStatus,
                });
            }
            this.respondJson(res, deployed ?? { error: 'automation-not-found' }, deployed ? 200 : 404);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/automations/revoke') {
            const body = await this.readJsonBody(req);
            const runtime = this.getRuntime();
            const revoked = runtime?.revokeAutomation(String(body.automationId));
            if (revoked) {
                nexusEventBus.emit('automation.revoke', {
                    automationId: revoked.automationId,
                    status: revoked.rolloutStatus,
                });
            }
            this.respondJson(res, revoked ?? { error: 'automation-not-found' }, revoked ? 200 : 404);
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/automations/run') {
            const body = await this.readJsonBody(req);
            const runtime = this.getRuntime();
            if (!runtime) {
                this.respondJson(res, { error: 'runtime-unavailable' }, 503);
                return;
            }
            const run = await runtime.runAutomation(String(body.automationId), body.goal ? String(body.goal) : undefined);
            nexusEventBus.emit('automation.run', {
                automationId: String(body.automationId),
                trigger: 'manual',
                queued: false,
            });
            this.respondJson(res, run, 201);
            return;
        }

        if (req.method === 'POST' && url.pathname.startsWith('/api/clients/') && url.pathname.endsWith('/reconnect')) {
            const clientId = decodeURIComponent(url.pathname.replace('/api/clients/', '').replace('/reconnect', '').replace(/\/$/, ''));
            const registry = this.getClientRegistry();
            if (!registry) {
                this.respondJson(res, { error: 'client-registry-unavailable' }, 503);
                return;
            }
            const client = registry.reconnect(clientId);
            nexusEventBus.emit('dashboard.action', {
                action: 'client.reconnect',
                status: 'ok',
                target: clientId,
            });
            this.respondJson(res, client);
            return;
        }

        if (req.method === 'POST' && url.pathname.startsWith('/api/clients/') && url.pathname.endsWith('/clear')) {
            const clientId = decodeURIComponent(url.pathname.replace('/api/clients/', '').replace('/clear', '').replace(/\/$/, ''));
            const registry = this.getClientRegistry();
            if (!registry) {
                this.respondJson(res, { error: 'client-registry-unavailable' }, 503);
                return;
            }
            registry.clear(clientId);
            nexusEventBus.emit('dashboard.action', {
                action: 'client.clear',
                status: 'ok',
                target: clientId,
            });
            this.respondJson(res, { ok: true, clientId });
            return;
        }

        res.writeHead(404);
        res.end('Not found');
      } catch (error) {
        if (!res.headersSent) {
            if (error instanceof Error && error.message === 'Request body too large') {
                res.writeHead(413, { 'Content-Type': 'text/plain' });
                res.end('Request body too large');
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Internal server error');
            }
        }
      }
    }

    private serveDashboard(res: http.ServerResponse): void {
        const securityHeaders = {
            'Content-Type': 'text/html',
            'Content-Security-Policy': [
                "default-src 'self'",
                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
                "font-src 'self' https://fonts.gstatic.com",
                "script-src 'unsafe-inline'",
                "connect-src 'self'",
                "img-src 'self' data:",
            ].join('; '),
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
        };

        if (this.cachedDashboardHtml) {
            res.writeHead(200, securityHeaders);
            res.end(this.cachedDashboardHtml);
            return;
        }

        const htmlPath = path.join(__dirname, 'index.html');
        fs.readFile(htmlPath, 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading dashboard HTML');
                return;
            }
            this.cachedDashboardHtml = data;
            res.writeHead(200, securityHeaders);
            res.end(data);
        });
    }

    private serveSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': this.getCorsOrigin(),
        });

        res.write('retry: 3000\n\n');
        res.write(`event: bootstrap\ndata: ${JSON.stringify({ connected: true, timestamp: Date.now(), version: DASHBOARD_API_VERSION })}\n\n`);

        const history = this.getEventCards();
        for (const evt of history) {
            res.write(`data: ${JSON.stringify(evt)}\n\n`);
        }

        this.clients.add(res);

        const pingInterval = setInterval(() => {
            res.write(':\n\n');
        }, 20000);
        pingInterval.unref();

        req.on('close', () => {
            clearInterval(pingInterval);
            this.clients.delete(res);
        });
    }

    private lastHeartbeatBroadcast = 0;

    private broadcast(event: NexusEvent): void {
        if (event.type === 'client.heartbeat') {
            const now = Date.now();
            if (now - this.lastHeartbeatBroadcast < 10000) return;
            this.lastHeartbeatBroadcast = now;
        }
        const normalized = this.normalizeEvent(event);
        const dataStr = `data: ${JSON.stringify(normalized)}\n\n`;
        for (const res of this.clients) {
            res.write(dataStr);
        }
    }

    private getCorsOrigin(): string {
        return this.dashboardUrl || `http://${HOST}:${this.activePort || DEFAULT_PORT}`;
    }

    private respondOptions(res: http.ServerResponse): void {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': this.getCorsOrigin(),
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
    }

    private respondJson(res: http.ServerResponse, data: unknown, statusCode: number = 200): void {
        res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': this.getCorsOrigin(),
        });
        res.end(JSON.stringify(data, null, 2));
    }

    private async readJsonBody(req: http.IncomingMessage): Promise<Record<string, any>> {
        const MAX_BODY = 1024 * 1024; // 1MB
        const chunks: Buffer[] = [];
        let totalLength = 0;
        for await (const chunk of req) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalLength += buf.length;
            if (totalLength > MAX_BODY) {
                throw new Error('Request body too large');
            }
            chunks.push(buf);
        }
        if (!chunks.length) return {};
        try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            return {};
        }
    }

    private getRuntime(): SubAgentRuntime | undefined {
        return this.runtimeProvider?.();
    }

    private resolveRuntimeSnapshot(url: URL) {
        const runtimes = this.runtimeRegistry.list();
        const runtimeId = url.searchParams.get('runtimeId')
            || this.getRuntime()?.getRuntimeId()
            || runtimes[0]?.runtimeId;
        if (!runtimeId) return undefined;
        return runtimes.find((runtime) => runtime.runtimeId === runtimeId) ?? this.runtimeRegistry.read(runtimeId);
    }

    private getOrchestrator(): OrchestratorEngine | undefined {
        return this.orchestratorProvider?.();
    }

    private getSynapse(): SynapseRuntime | undefined {
        return this.synapseProvider?.();
    }

    private getArchitects(): ArchitectsRuntime | undefined {
        return this.architectsProvider?.();
    }

    private getMemory(): MemoryEngine | undefined {
        return this.memoryProvider?.();
    }

    private getAdapters(): Adapter[] {
        return this.adaptersProvider?.() ?? [];
    }

    private getClientRegistry(): ClientRegistry | undefined {
        return this.clientRegistryProvider?.();
    }

    private getEventCards(): DashboardEventCard[] {
        return nexusEventBus.getHistory().map((event) => this.normalizeEvent(event)).reverse();
    }

    private normalizeEvent(event: NexusEvent): DashboardEventCard {
        const category = mapEventCategory(event.type);
        const severity = mapEventSeverity(event.type, event.data as Record<string, unknown>);

        return {
            id: event.id,
            type: event.type,
            title: mapEventTitle(event.type),
            source: mapEventSource(event.type, event.data as Record<string, unknown>),
            time: event.timestamp,
            severity,
            category,
            summary: summarizeEvent(event.type, event.data as Record<string, unknown>),
            payload: event.data,
        };
    }

    private async getCachedValue<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
        const now = Date.now();
        const cached = this.endpointCache.get(key) as CachedResponse<T> | undefined;
        if (cached?.value !== undefined && cached.expiresAt > now) {
            return cached.value;
        }
        if (cached?.refresh) {
            return cached.value !== undefined ? cached.value : cached.refresh;
        }

        const refresh = producer()
            .then((value) => {
                this.endpointCache.set(key, {
                    value,
                    expiresAt: Date.now() + ttlMs,
                });
                return value;
            })
            .finally(() => {
                const latest = this.endpointCache.get(key) as CachedResponse<T> | undefined;
                if (latest?.refresh) {
                    this.endpointCache.set(key, {
                        value: latest.value,
                        expiresAt: latest.expiresAt,
                    });
                }
            });

        this.endpointCache.set(key, {
            value: cached?.value,
            expiresAt: cached?.expiresAt ?? 0,
            refresh,
        });
        return cached?.value !== undefined ? cached.value : refresh;
    }

    private async readJsonIfExists(target: string): Promise<Record<string, unknown> | null> {
        try {
            const raw = await fs.promises.readFile(target, 'utf8');
            return JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return null;
        }
    }

    private async fileExists(target: string): Promise<boolean> {
        try {
            await fs.promises.access(target);
            return true;
        } catch {
            return false;
        }
    }

    private collectUsageSnapshot(url: URL) {
        const runtimes = this.runtimeRegistry.list();
        const requestedRuntimeId = url.searchParams.get('runtimeId') || this.getRuntime()?.getRuntimeId() || runtimes[0]?.runtimeId;
        const selected = requestedRuntimeId
            ? runtimes.find((runtime) => runtime.runtimeId === requestedRuntimeId) ?? this.runtimeRegistry.read(requestedRuntimeId)
            : undefined;
        return selected ?? {
            runtimeId: requestedRuntimeId ?? null,
            health: 'stale',
            usage: {},
            libraries: {},
            latestRun: null,
        };
    }

    private listDashboardMemories(options: {
        limit?: number;
        tier?: 'prefrontal' | 'hippocampus' | 'cortex';
        tag?: string;
        linkedType?: 'session' | 'run' | 'skill' | 'workflow';
        recencyMs?: number;
        showPhantom?: boolean;
        lane?: 'profile' | 'workspace' | 'shared' | 'inbox';
        repoId?: string;
        workspaceId?: string;
        projectId?: string;
        includeHidden?: boolean;
    } = {}) {
        const limit = Math.max(1, Number(options.limit || 40));
        const raw = this.getMemory()?.listSnapshots(Math.min(limit * 3, 200), {
            tier: options.tier,
            tag: options.tag,
            linkedType: options.linkedType,
            recencyMs: options.recencyMs,
            lane: options.lane,
            repoId: options.repoId,
            workspaceId: options.workspaceId,
            projectId: options.projectId,
            includeHidden: options.includeHidden,
        }) ?? [];
        return raw
            .filter((memory: any) => {
                const tags: string[] = Array.isArray(memory.tags) ? memory.tags : [];
                if (tags.includes('#quarantine') && options.lane !== 'inbox') return false;
                if (!options.showPhantom && (tags.includes('#phantom-learning') || tags.includes('#swarm'))) return false;
                if (!options.includeHidden && (tags.includes('#hidden') || tags.includes('#repo-profile') || tags.includes('#system-hidden'))) return false;
                return true;
            })
            .slice(0, limit);
    }

    private collectTokenOptimization(snapshot: any, usage: any) {
        const tokens = snapshot?.tokens ?? this.getRuntime()?.getTokenTelemetrySummary?.() ?? {};
        const budget = usage?.sourceAwareTokenBudget ?? {};
        return {
            applied: Boolean(usage?.tokenOptimizationApplied || budget?.applied),
            savedTokens: Number(tokens?.savedTokens || 0),
            forwardedTokens: Number(tokens?.forwardedTokens || 0),
            grossInputTokens: Number(tokens?.grossInputTokens || 0),
            compressionPct: Number(tokens?.compressionPct || 0),
            reason: budget?.reason || 'Token optimization has not reported a source-aware budget yet.',
            dominantSource: budget?.dominantSource || null,
            dropped: Array.isArray(budget?.dropped) ? budget.dropped : [],
        };
    }

    private collectGateSummary(run: any) {
        const gates = Array.isArray(run?.plannerState?.reviewGates)
            ? run.plannerState.reviewGates
            : Array.isArray(run?.plannerResult?.reviewGates)
                ? run.plannerResult.reviewGates
                : [];
        const counts = gates.reduce((acc: Record<string, number>, gate: any) => {
            const key = String(gate?.status || 'planned');
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});
        return {
            total: gates.length,
            ready: Number(counts.ready || 0),
            blocked: Number(counts.blocked || 0),
            planned: Number(counts.planned || 0),
            skipped: Number(counts.skipped || 0),
            items: gates,
        };
    }

    private collectInterpretationIssues(input: {
        usage: any;
        latestRun: any;
        memoryHealth: any;
    }) {
        const issues: Array<{ id: string; severity: 'info' | 'warn' | 'bad'; summary: string }> = [];
        const selectionAudit = input.usage?.artifactSelectionAudit ?? {};
        const rejected = Array.isArray(selectionAudit?.rejected) ? selectionAudit.rejected : [];
        const latestRunResult = String(input.latestRun?.result || '');

        const lowConfidenceRejected = rejected.filter((entry: any) => entry?.source === 'scorer' && entry?.confidence === 'low');
        if (lowConfidenceRejected.length > 0) {
            issues.push({
                id: 'selection-low-confidence',
                severity: 'warn',
                summary: `${lowConfidenceRejected.length} low-confidence scorer suggestion(s) were rejected to avoid cross-domain misrouting.`,
            });
        }
        if (/review gate .* remains blocked/i.test(latestRunResult)) {
            issues.push({
                id: 'gate-blocked',
                severity: 'bad',
                summary: latestRunResult,
            });
        }
        if (Number(input.memoryHealth?.quarantined || 0) > 0) {
            issues.push({
                id: 'memory-quarantine',
                severity: 'info',
                summary: `${input.memoryHealth.quarantined} memory entr${input.memoryHealth.quarantined === 1 ? 'y is' : 'ies are'} quarantined or inboxed for review.`,
            });
        }
        return issues;
    }

    private collectMemoryQualitySummary(memoryHealth: any, containers: any) {
        return {
            active: Number(memoryHealth?.active || 0),
            quarantined: Number(memoryHealth?.quarantined || 0),
            workspace: Number(containers?.byLane?.workspace || 0),
            profile: Number(containers?.byLane?.profile || 0),
            shared: Number(containers?.byLane?.shared || 0),
            inbox: Number(containers?.byLane?.inbox || 0),
            hiddenCount: Number(containers?.hiddenCount || 0),
            topTags: Array.isArray(memoryHealth?.topTags) ? memoryHealth.topTags : [],
        };
    }

    private buildDashboardAlerts(payload: {
        health: DashboardHealthResponse;
        usage: any;
        memoryHealth: any;
    }) {
        const alerts: Array<{ id: string; tone: 'info' | 'warn' | 'bad'; title: string; summary: string }> = [];
        const healthMemory = (payload.health.memory || {}) as any;
        const healthConnection = (payload.health.connection || {}) as any;

        if (payload.usage?.health === 'stale') {
            alerts.push({
                id: 'runtime-stale',
                tone: 'warn',
                title: 'Selected runtime is stale',
                summary: 'Run mutations and deploy controls stay guarded until a fresh runtime heartbeat appears.',
            });
        }

        if (healthMemory.storage?.fallbackApplied) {
            alerts.push({
                id: 'memory-fallback',
                tone: 'warn',
                title: 'Memory storage fallback active',
                summary: `Using ${healthMemory.storage.activeDbPath} because the requested database path was not writable.`,
            });
        }

        if (Number(payload.memoryHealth?.quarantined || 0) > 0) {
            alerts.push({
                id: 'memory-quarantine',
                tone: 'info',
                title: 'Quarantined memory needs review',
                summary: `${payload.memoryHealth.quarantined} memory entr${payload.memoryHealth.quarantined === 1 ? 'y' : 'ies'} are quarantined in the trust layer.`,
            });
        }

        if (healthConnection.stream !== 'connected') {
            alerts.push({
                id: 'stream-idle',
                tone: 'info',
                title: 'Live stream not attached',
                summary: 'The dashboard is polling snapshots instead of consuming the live operator stream.',
            });
        }

        return alerts;
    }

    private async collectDashboardSummary(url: URL) {
        const usage = this.collectUsageSnapshot(url);
        const snapshot = this.resolveRuntimeSnapshot(url);
        const runtime = this.getRuntime();
        const orchestrator = this.getOrchestrator();
        const memory = this.getMemory();
        const health = await this.getCachedValue('health', 15_000, () => this.collectHealth());
        const layer = memory ? new NexusLayerAdapter(memory, runtime, orchestrator) : null;
        const clients = snapshot?.clients?.detected?.length
            ? snapshot.clients.detected
            : this.getClientRegistry()?.listClients(this.getAdapters()) ?? [];
        const primaryClient = snapshot?.clients?.primary ?? this.getClientRegistry()?.getPrimaryClient(this.getAdapters()) ?? null;
        const memoryHealth = runtime?.getMemoryHealth() ?? memory?.getHealthSummary() ?? {
            generatedAt: Date.now(),
            total: 0,
            active: 0,
            quarantined: 0,
            scrap: 0,
            promoted: 0,
            shared: 0,
            topTags: [],
        };
        const latestRun = snapshot?.runtimeId && runtime?.getRuntimeId() === snapshot.runtimeId
            ? runtime?.listRuns?.(1)?.[0] ?? usage?.latestRun ?? null
            : usage?.latestRun ?? null;
        const tokenOptimization = this.collectTokenOptimization(snapshot, usage);
        const memoryContainers = memory?.getContainerSummary(snapshot?.orchestration?.sessionId) ?? null;
        const gateSummary = this.collectGateSummary(latestRun);
        const interpretationIssues = this.collectInterpretationIssues({ usage, latestRun, memoryHealth });
        const sharedMemory = snapshot?.runtimeId && runtime?.getRuntimeId() === snapshot.runtimeId
            ? runtime.getSharedMemorySnapshot?.(12) ?? []
            : [];

        return {
            generatedAt: Date.now(),
            selectedRuntimeId: usage?.runtimeId ?? runtime?.getRuntimeId() ?? null,
            health,
            runtimes: this.runtimeRegistry.list(),
            usage,
            latestRun,
            orchestrationSession: snapshot?.orchestration ?? orchestrator?.getSessionState?.() ?? {},
            memoryHealth,
            memoryShared: sharedMemory,
            memoryContainers,
            gateSummary,
            tokenOptimization,
            interpretationIssues,
            preCompactionBackup: memory?.getLastPreCompactionBackup?.() ?? null,
            backends: runtime?.getBackendCatalog() ?? {},
            clients,
            primaryClient,
            nexusLayer: layer?.getSummary(snapshot?.orchestration?.sessionId) ?? null,
            ragCollections: orchestrator?.listRagCollections?.() ?? [],
            ragAttachedCount: (orchestrator?.listRagCollections?.() ?? [])
                .filter((c: any) => c.attached).length,
            patterns: orchestrator?.listPatterns?.()?.slice(0, 5) ?? [],
            alerts: this.buildDashboardAlerts({ health, usage, memoryHealth }),
        };
    }

    private async collectDashboardSurface(surface: DashboardSurfaceMode, url: URL) {
        const snapshot = this.resolveRuntimeSnapshot(url);
        const runtime = this.getRuntime();
        const orchestrator = this.getOrchestrator();
        const memory = this.getMemory();
        const usage = this.collectUsageSnapshot(url);
        const layer = memory ? new NexusLayerAdapter(memory, runtime, orchestrator) : null;
        const latestRun = snapshot?.runtimeId && runtime?.getRuntimeId() === snapshot.runtimeId
            ? runtime?.listRuns?.(1)?.[0] ?? usage?.latestRun ?? null
            : usage?.latestRun ?? null;
        const memoryHealth = runtime?.getMemoryHealth() ?? memory?.getHealthSummary() ?? {};
        const memoryContainers = memory?.getContainerSummary(snapshot?.orchestration?.sessionId) ?? null;
        const tokenOptimization = this.collectTokenOptimization(snapshot, usage);
        const gateSummary = this.collectGateSummary(latestRun);
        const interpretationIssues = this.collectInterpretationIssues({ usage, latestRun, memoryHealth });

        switch (surface) {
            case 'operate':
                return {
                    runs: runtime?.listRuns(12) ?? [],
                    usage,
                    tokenOptimization,
                    gateSummary,
                    memoryContainers,
                    interpretationIssues,
                    orchestrationSession: snapshot?.orchestration ?? orchestrator?.getSessionState?.() ?? {},
                    orchestrationLedger: snapshot?.executionLedger ?? runtime?.getExecutionLedger() ?? {},
                    instructionPacket: snapshot?.instructionPacket ?? runtime?.getInstructionPacket() ?? {},
                    tokensSummary: snapshot?.tokens ?? runtime?.getTokenTelemetrySummary() ?? {},
                    tokensTimeline: snapshot?.tokens?.timeline ?? runtime?.getTokenTelemetryTimeline(12) ?? [],
                    tokensBySource: snapshot?.tokens?.bySourceClass ?? runtime?.getTokenTelemetrySummary()?.bySourceClass ?? {},
                    memory: this.listDashboardMemories({ limit: 12 }),
                    memoryHealth,
                    memoryShared: snapshot?.runtimeId && runtime?.getRuntimeId() === snapshot.runtimeId ? runtime.getSharedMemorySnapshot?.(8) ?? [] : [],
                    clients: snapshot?.clients?.detected?.length ? snapshot.clients.detected : this.getClientRegistry()?.listClients(this.getAdapters()) ?? [],
                    primaryClient: snapshot?.clients?.primary ?? this.getClientRegistry()?.getPrimaryClient(this.getAdapters()) ?? null,
                };
            case 'memory':
                return {
                    usage,
                    memory: this.listDashboardMemories({ limit: 40, lane: 'workspace' }),
                    workspace: this.listDashboardMemories({ limit: 28, lane: 'workspace' }),
                    profile: this.listDashboardMemories({ limit: 18, lane: 'profile' }),
                    shared: this.listDashboardMemories({ limit: 18, lane: 'shared' }),
                    inbox: this.listDashboardMemories({ limit: 18, lane: 'inbox', includeHidden: true }),
                    memoryHealth,
                    memoryContainers,
                    qualitySummary: this.collectMemoryQualitySummary(memoryHealth, memoryContainers),
                    memoryAudit: runtime?.auditMemory(80) ?? { scanned: 0, quarantined: [], findings: [] },
                    memoryQuarantine: runtime?.listMemoryQuarantine(40) ?? [],
                    memoryShared: snapshot?.runtimeId && runtime?.getRuntimeId() === snapshot.runtimeId ? runtime.getSharedMemorySnapshot?.(12) ?? [] : [],
                    knowledgeFabricSession: snapshot?.knowledgeFabric ?? orchestrator?.getKnowledgeFabricSnapshot?.() ?? {},
                    knowledgeProvenance: snapshot?.knowledgeFabric?.provenance ?? orchestrator?.getKnowledgeFabricProvenance?.() ?? { entries: [] },
                    ragCollections: orchestrator?.listRagCollections?.() ?? [],
                    patterns: orchestrator?.listPatterns?.()?.slice(0, 8) ?? [],
                    modelTiers: snapshot?.knowledgeFabric
                        ? { policy: snapshot.knowledgeFabric.modelTierPolicy, trace: snapshot.knowledgeFabric.modelTierTrace }
                        : orchestrator?.getModelTierTrace?.() ?? { trace: [] },
                    nexusLayer: layer?.getSummary(snapshot?.orchestration?.sessionId) ?? null,
                };
            case 'runs':
                return {
                    runs: runtime?.listRuns(20) ?? [],
                    usage,
                    gateSummary,
                    selectionAudit: (usage as any)?.artifactSelectionAudit ?? { selected: [], rejected: [], summary: 'No selection audit recorded yet.' },
                    gateTimeline: Array.isArray(latestRun?.plannerState?.reviewGates) ? latestRun.plannerState.reviewGates : [],
                    parallelism: {
                        totalWorkers: Number(snapshot?.workerPlan?.totalWorkers ?? runtime?.getUsageSnapshot()?.workerPlan?.totalWorkers ?? 0),
                        lanes: snapshot?.workerPlan?.lanes ?? runtime?.getUsageSnapshot()?.workerPlan?.lanes ?? [],
                    },
                    tokenOptimization,
                    orchestrationSession: snapshot?.orchestration ?? orchestrator?.getSessionState?.() ?? {},
                    orchestrationLedger: snapshot?.executionLedger ?? runtime?.getExecutionLedger() ?? {},
                    workerPlan: snapshot?.workerPlan ?? runtime?.getUsageSnapshot()?.workerPlan ?? {},
                    artifactOutcomes: snapshot?.artifactOutcome ?? runtime?.getUsageSnapshot()?.artifactOutcome ?? {},
                    instructionPacket: snapshot?.instructionPacket ?? runtime?.getInstructionPacket() ?? {},
                    tokensSummary: snapshot?.tokens ?? runtime?.getTokenTelemetrySummary() ?? {},
                    tokensTimeline: snapshot?.tokens?.timeline ?? runtime?.getTokenTelemetryTimeline(20) ?? [],
                    tokensBySource: snapshot?.tokens?.bySourceClass ?? runtime?.getTokenTelemetrySummary()?.bySourceClass ?? {},
                    worktreeHealth: snapshot?.worktreeHealth ?? runtime?.getUsageSnapshot()?.worktreeHealth ?? {},
                };
            case 'assets':
                return {
                    usage,
                    selectionAudit: (usage as any)?.artifactSelectionAudit ?? { selected: [], rejected: [], summary: 'No selection audit recorded yet.' },
                    featureRegistry: await this.getCachedValue('feature-registry', 30_000, () => Promise.resolve(buildFeatureRegistry(this.repoRoot))),
                    skills: runtime?.listSkills() ?? [],
                    specialists: (runtime?.listSpecialists() ?? []).map((specialist) => ({
                        specialistId: specialist.specialistId,
                        name: specialist.name,
                        division: specialist.division,
                        description: specialist.description,
                        authority: specialist.authority,
                        domains: specialist.domains,
                        tools: specialist.tools,
                        mission: specialist.mission,
                        workflow: specialist.workflow,
                        deliverables: specialist.deliverables,
                        communicationStyle: specialist.communicationStyle,
                        successMetrics: specialist.successMetrics,
                        recommendedSkills: specialist.recommendedSkills,
                        recommendedWorkflows: specialist.recommendedWorkflows,
                        sourcePath: specialist.sourcePath,
                    })),
                    crews: runtime?.listCrews() ?? [],
                    workflows: runtime?.listWorkflows() ?? [],
                    hooks: runtime?.listHooks() ?? [],
                    automations: runtime?.listAutomations() ?? [],
                    backends: runtime?.getBackendCatalog() ?? {},
                };
            case 'trust':
                return {
                    usage,
                    interpretationIssues,
                    preCompactionBackup: memory?.getLastPreCompactionBackup?.() ?? null,
                    memoryContainers,
                    health: await this.getCachedValue('health', 15_000, () => this.collectHealth()),
                    worktreeHealth: snapshot?.worktreeHealth ?? runtime?.getUsageSnapshot()?.worktreeHealth ?? {},
                    federation: runtime?.getNetworkStatus() ?? {},
                    memoryAudit: runtime?.auditMemory(80) ?? { scanned: 0, quarantined: [], findings: [] },
                    memoryQuarantine: runtime?.listMemoryQuarantine(40) ?? [],
                    synapseTeams: this.getSynapse()?.getStrikeTeamStatus() ?? [],
                    synapseHealth: this.getSynapse()?.getOperativeHealth() ?? [],
                    synapseApprovals: this.getSynapse()?.getPendingApprovals() ?? [],
                    architectsDispatch: this.getArchitects()?.getDispatchStatus() ?? {},
                    architectsEscalations: this.getArchitects()?.getWardEscalations() ?? [],
                    clients: snapshot?.clients?.detected?.length ? snapshot.clients.detected : this.getClientRegistry()?.listClients(this.getAdapters()) ?? [],
                    primaryClient: snapshot?.clients?.primary ?? this.getClientRegistry()?.getPrimaryClient(this.getAdapters()) ?? null,
                    nexusLayer: layer?.getSummary(snapshot?.orchestration?.sessionId) ?? null,
                };
            default:
                return { error: 'dashboard-surface-not-found', surface };
        }
    }

    private resolveDashboardEntity(kind: string, id: string, url: URL) {
        if (kind === 'run') return this.getRuntime()?.getRun(id);
        if (kind === 'memory') return this.getMemory()?.trace?.(id) ?? this.getMemory()?.getDetail(id);
        if (kind === 'skill') return this.getRuntime()?.listSkills().find((item) => item.skillId === id);
        if (kind === 'workflow') return this.getRuntime()?.listWorkflows().find((item) => item.workflowId === id);
        if (kind === 'hook') return this.getRuntime()?.listHooks().find((item) => item.hookId === id);
        if (kind === 'automation') return this.getRuntime()?.listAutomations().find((item) => item.automationId === id);
        if (kind === 'specialist') return this.getRuntime()?.listSpecialists().find((item) => item.specialistId === id);
        if (kind === 'crew') return this.getRuntime()?.listCrews().find((item) => item.crewId === id);
        if (kind === 'client') {
            const snapshot = this.resolveRuntimeSnapshot(url);
            const clients = snapshot?.clients?.detected?.length ? snapshot.clients.detected : this.getClientRegistry()?.listClients(this.getAdapters()) ?? [];
            return clients.find((client: any) => client.clientId === id);
        }
        if (kind === 'federation-peer') {
            const peers = this.getRuntime()?.getNetworkStatus() as { knownPeers?: Array<{ peerId: string }> } | undefined;
            return peers?.knownPeers?.find((peer) => peer.peerId === id);
        }
        return null;
    }

    private async collectHealth(): Promise<DashboardHealthResponse> {
        const packageJsonPath = path.join(this.repoRoot, 'package.json');
        const workflowPath = path.join(this.repoRoot, '.github', 'workflows', 'pages.yml');
        const docsDir = path.join(this.repoRoot, 'docs');
        const runtime = this.getRuntime();
        const memory = this.getMemory();
        const clientRegistry = this.getClientRegistry();
        const podSnapshot = podNetwork.getDashboardSnapshot(20);
        const runtimes = this.runtimeRegistry.list();

        let packageVersion = 'unknown';
        const ownPkgPath = path.join(__dirname, '..', 'package.json');
        const ownPkgPath2 = path.join(__dirname, '..', '..', 'package.json');
        for (const candidate of [ownPkgPath, ownPkgPath2, packageJsonPath]) {
            if (packageVersion !== 'unknown') break;
            const pkg = await this.readJsonIfExists(candidate);
            const version = typeof pkg?.version === 'string' ? pkg.version : '';
            if (version) {
                packageVersion = version;
            }
        }

        if (!this.gitUser) {
            const gitConfigPath = path.join(this.repoRoot, '.git', 'config');
            if (await this.fileExists(gitConfigPath)) {
                try {
                    const gitConfig = await fs.promises.readFile(gitConfigPath, 'utf8');
                    const match = gitConfig.match(/name\s*=\s*(.+)/);
                    this.gitUser = match?.[1]?.trim() || '';
                } catch {
                    this.gitUser = '';
                }
            }
        }

        let pagesWorkflowValid = false;
        try {
            const raw = await fs.promises.readFile(workflowPath, 'utf8');
            pagesWorkflowValid = raw.includes('steps.deployment.outputs.page_url');
        } catch {
            // Keep the workflow flag false when the file is missing or unreadable.
        }

        const clients = clientRegistry?.listClients(this.getAdapters()) ?? [];
        const primaryClient = clientRegistry?.getPrimaryClient(this.getAdapters());
        const docsPresent = await this.fileExists(docsDir);
        const packagePresent = await this.fileExists(packageJsonPath);

        return {
            dashboardApiVersion: DASHBOARD_API_VERSION,
            capabilities: {
                ...CORE_CAPABILITIES,
                hooks: !!runtime,
                automations: !!runtime,
                federation: !!runtime?.getNetworkStatus,
                specialists: !!runtime,
                crews: !!runtime,
                planner: !!this.orchestratorProvider?.(),
                orchestration: !!this.orchestratorProvider?.(),
                clientPrimary: !!primaryClient,
                instructionPacket: !!this.orchestratorProvider?.(),
                orchestrationLedger: !!this.orchestratorProvider?.(),
                knowledgeFabric: !!memory,
                ragCollections: !!memory,
                patterns: !!runtime,
                modelTiers: !!runtime,
                workerPlan: !!runtime,
                artifactOutcomes: !!runtime,
                memoryTrace: !!memory,
                memoryShared: !!memory,
                worktreeHealth: !!runtime,
                featureRegistry: true,
                synapse: !!this.synapseProvider?.(),
                architects: !!this.architectsProvider?.(),
                dashboardSummary: true,
                dashboardSurfaces: true,
                nexusLayer: true,
            },
            dashboardUrl: this.getAddress(),
            dashboardMode: this.dashboardMode,
            connection: {
                stream: this.clients.size > 0 ? 'connected' : 'idle',
                subscribers: this.clients.size,
            },
            runtime: {
                ...(runtime?.getHealth() ?? { runtime: 'unavailable' }),
                runtimeCount: runtimes.length,
                selectedRuntimeId: runtime?.getRuntimeId() ?? runtimes[0]?.runtimeId ?? null,
            },
            memory: {
                ...(memory?.getStats() ?? { prefrontal: 0, hippocampus: 0, cortex: 0, totalLinks: 0, oldestEntry: null, topTags: [] }),
                storage: memory?.getStorageStatus?.() ?? null,
            },
            pod: {
                workers: podSnapshot.activeWorkers.length,
                lastMessageTimestamp: podSnapshot.lastMessageTimestamp,
                confidenceBands: podSnapshot.confidenceBands,
            },
            clients: {
                total: clients.length,
                active: clients.filter((client) => client.state === 'primaryActive' || client.state === 'active').length,
                installed: clients.filter((client) => client.state === 'installed').length,
                primary: primaryClient ? {
                    clientId: primaryClient.clientId,
                    displayName: primaryClient.displayName,
                    state: primaryClient.state,
                    source: primaryClient.source,
                } : null,
            },
            release: {
                packageVersion,
                gitUser: this.gitUser,
            },
            docs: {
                present: docsPresent,
                pagesWorkflowValid,
            },
            ci: {
                lintScriptPresent: packagePresent,
                eventHistory: nexusEventBus.getHistory().length,
            },
        };
    }

    private buildUrl(port: number): string {
        return `http://${HOST}:${port}`;
    }

    private async probeDashboard(port: number): Promise<DashboardCompatibilityProbe> {
        const url = this.buildUrl(port);

        try {
            const response = await this.requestProbe(`${url}/api/health`);

            if (response.statusCode !== 200) {
                return {
                    status: 'incompatible',
                    url,
                    reason: `health-status-${response.statusCode}`,
                };
            }

            let payload: DashboardHealthResponse | null = null;
            try {
                payload = JSON.parse(response.body) as DashboardHealthResponse;
            } catch {
                return {
                    status: 'incompatible',
                    url,
                    reason: 'health-invalid-json',
                };
            }

            if (this.isCompatibleHealth(payload)) {
                return {
                    status: 'compatible',
                    url,
                    health: payload,
                };
            }

            return {
                status: 'incompatible',
                url,
                health: payload,
                reason: 'health-incompatible',
            };
        } catch (error) {
            if (this.isFreePortProbeError(error)) {
                return {
                    status: 'free',
                    url,
                    reason: error instanceof Error ? error.message : 'connection-refused',
                };
            }

            return {
                status: 'incompatible',
                url,
                reason: error instanceof Error ? error.message : 'probe-failed',
            };
        }
    }

    private isCompatibleHealth(payload: DashboardHealthResponse | null | undefined): payload is DashboardHealthResponse {
        if (!payload || payload.dashboardApiVersion !== DASHBOARD_API_VERSION) {
            return false;
        }

        return Object.entries(CORE_CAPABILITIES).every(([key, expected]) => payload.capabilities?.[key] === expected);
    }

    private isFreePortProbeError(error: unknown): boolean {
        const code = typeof error === 'object' && error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
        return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND';
    }

    private requestProbe(url: string): Promise<DashboardProbeResponse> {
        return new Promise((resolve, reject) => {
            const req = http.get(url, { timeout: 1200 }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk) => {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                });
                res.on('end', () => {
                    resolve({
                        statusCode: res.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString('utf8'),
                    });
                });
            });

            req.on('timeout', () => {
                req.destroy(new Error('probe-timeout'));
            });
            req.on('error', reject);
        });
    }

    private async bindFirstAvailablePort(startPort: number, endPort: number): Promise<number> {
        let lastError: unknown = null;

        for (let port = startPort; port <= endPort; port += 1) {
            try {
                await this.listenOnPort(port);
                return port;
            } catch (error) {
                lastError = error;
                const code = typeof error === 'object' && error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
                if (code !== 'EADDRINUSE') {
                    throw error;
                }
            }
        }

        throw lastError instanceof Error
            ? lastError
            : new Error(`No free dashboard port found in range ${startPort}-${endPort}`);
    }

    private listenOnPort(port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const handleListening = () => {
                cleanup();
                resolve();
            };
            const handleError = (error: NodeJS.ErrnoException) => {
                cleanup();
                reject(error);
            };
            const cleanup = () => {
                this.server.off('listening', handleListening);
                this.server.off('error', handleError);
            };

            this.server.once('listening', handleListening);
            this.server.once('error', handleError);
            this.server.listen(port, HOST);
        });
    }
}

function mapEventCategory(type: NexusEventType): DashboardEventCard['category'] {
    if (type.startsWith('planner.')) return 'runtime';
    if (type.startsWith('memory.')) return 'memory';
    if (type.startsWith('pod.')) return 'pod';
    if (type.startsWith('phantom.')) return 'runtime';
    if (type.startsWith('client.')) return 'clients';
    if (type.startsWith('skill.')) return 'skills';
    if (type.startsWith('hook.')) return 'hooks';
    if (type.startsWith('workflow.')) return 'workflows';
    if (type.startsWith('automation.')) return 'automations';
    if (type.startsWith('shield.')) return 'shield';
    if (type.startsWith('federation.') || type.startsWith('nexusnet.')) return 'federation';
    if (type.startsWith('tokens.') || type.startsWith('cas.') || type.startsWith('kv.')) return 'tokens';
    return 'system';
}

function mapEventSeverity(type: NexusEventType, payload: Record<string, unknown>): DashboardEventCard['severity'] {
    if (type === 'guardrail.check') {
        return payload.passed ? 'good' : 'bad';
    }
    if (type === 'phantom.merge' || type === 'phantom.merge.complete' || type === 'workflow.run') {
        return payload.status === 'failed' ? 'bad' : 'good';
    }
    if (type === 'client.inferred') return 'warn';
    if (type === 'dashboard.action' && payload.status === 'failed') return 'bad';
    if (type === 'pod.signal') return 'info';
    if (type === 'shield.decision') return payload.blocked ? 'bad' : payload.action === 'quarantine' ? 'warn' : 'info';
    return 'info';
}

function mapEventTitle(type: NexusEventType): string {
    return {
        'system.boot': 'Runtime boot',
        'planner.stage': 'Planner stage',
        'memory.store': 'Memory stored',
        'memory.recall': 'Memory recall',
        'pod.signal': 'POD signal',
        'tokens.optimized': 'Tokens optimized',
        'phantom.worker.start': 'Worker start',
        'phantom.worker.complete': 'Worker complete',
        'phantom.merge.complete': 'Merge complete',
        'phantom.merge': 'Merge decision',
        'guardrail.check': 'Guardrail check',
        'ghost.pass': 'Ghost pass',
        'graph.query': 'Graph query',
        'darwin.cycle': 'Darwin cycle',
        'session.dna': 'Session DNA',
        'skill.register': 'Skill registered',
        'skill.deploy': 'Skill deployed',
        'skill.revoke': 'Skill revoked',
        'hook.deploy': 'Hook deployed',
        'hook.revoke': 'Hook revoked',
        'hook.fire': 'Hook fired',
        'workflow.deploy': 'Workflow deployed',
        'workflow.run': 'Workflow run',
        'automation.deploy': 'Automation deployed',
        'automation.revoke': 'Automation revoked',
        'automation.run': 'Automation run',
        'shield.decision': 'Shield decision',
        'memory.audit': 'Memory audit',
        'federation.heartbeat': 'Federation heartbeat',
        'client.heartbeat': 'Client heartbeat',
        'client.inferred': 'Client inferred',
        'client.status': 'Client status',
        'dashboard.action': 'Dashboard action',
        'nexusnet.publish': 'NexusNet publish',
        'nexusnet.sync': 'NexusNet sync',
        'entanglement.create': 'Entanglement created',
        'entanglement.collapse': 'Entanglement collapsed',
        'entanglement.correlate': 'Entanglement correlated',
        'cas.encode': 'CAS encode',
        'cas.decode': 'CAS decode',
        'cas.pattern_learned': 'CAS pattern',
        'kv.merge': 'KV merge',
        'kv.adapt': 'KV adapt',
        'kv.consensus': 'KV consensus',
    }[type] ?? type;
}

function mapEventSource(type: NexusEventType, payload: Record<string, unknown>): string {
    if (type.startsWith('planner.')) return String(payload.owner ?? payload.runId ?? 'planner');
    if (type.startsWith('client.')) return String(payload.displayName ?? payload.clientId ?? 'client');
    if (type === 'pod.signal') return String(payload.workerId ?? 'pod');
    if (type.startsWith('phantom.')) return String(payload.workerId ?? payload.winner ?? 'runtime');
    if (type.startsWith('skill.')) return String(payload.skillId ?? payload.name ?? 'skill');
    if (type.startsWith('hook.')) return String(payload.hookId ?? payload.name ?? 'hook');
    if (type.startsWith('workflow.')) return String(payload.workflowId ?? 'workflow');
    if (type.startsWith('automation.')) return String(payload.automationId ?? 'automation');
    if (type.startsWith('shield.')) return String(payload.target ?? 'shield');
    if (type.startsWith('federation.')) return String(payload.peerId ?? 'federation');
    return 'nexus-prime';
}

function summarizeEvent(type: NexusEventType, payload: Record<string, unknown>): string {
    switch (type) {
        case 'planner.stage':
            return `${payload.stage ?? 'stage'} · ${payload.status ?? 'unknown'} · ${payload.assets ?? 0} asset(s)`;
        case 'memory.store':
            return `Priority ${payload.priority ?? 'n/a'} · ${(payload.tags as string[] | undefined)?.join(', ') ?? 'no tags'}`;
        case 'memory.recall':
            return `Recalled ${payload.count ?? 0} memories for "${payload.query ?? ''}"`;
        case 'pod.signal':
            return String(payload.content ?? 'POD signal received');
        case 'tokens.optimized':
            return `Saved ${payload.savings ?? 0} tokens across ${payload.files ?? 0} files`;
        case 'phantom.worker.start':
            return `${payload.approach ?? 'worker'} started for ${payload.goal ?? 'task'}`;
        case 'phantom.worker.complete':
            return `Confidence ${payload.confidence ?? 0}`;
        case 'phantom.merge':
            return `${payload.action ?? 'merge'} · ${payload.winner ?? 'unknown winner'}`;
        case 'client.heartbeat':
        case 'client.inferred':
        case 'client.status':
            return JSON.stringify(payload);
        case 'hook.fire':
            return `${payload.name ?? payload.hookId ?? 'hook'} @ ${payload.trigger ?? 'unknown trigger'}`;
        case 'automation.run':
            return `${payload.automationId ?? 'automation'} @ ${payload.trigger ?? 'unknown trigger'}${payload.queued ? ' queued' : ''}`;
        case 'shield.decision':
            return `${payload.action ?? 'allow'} · ${payload.target ?? 'unknown target'}`;
        case 'memory.audit':
            return `Scanned ${payload.scanned ?? 0} memories · quarantined ${payload.quarantined ?? 0}`;
        case 'federation.heartbeat':
            return `${payload.peerId ?? 'peer'} · ${payload.health ?? 'unknown'} · ${payload.capabilities ?? 0} capabilities`;
        case 'dashboard.action':
            return `${payload.action ?? 'action'} → ${payload.status ?? 'unknown'}`;
        default:
            return JSON.stringify(payload);
    }
}
