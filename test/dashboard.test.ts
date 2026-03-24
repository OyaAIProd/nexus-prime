import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import http from 'http';
import { execSync } from 'child_process';

function setupFixtureRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-prime-dashboard-'));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Dashboard Fixture\n', 'utf8');
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({
      name: 'nexus-prime-dashboard-fixture',
      version: '1.0.0',
      private: true,
      scripts: {
        build: 'node -e "process.exit(0)"'
      }
    }, null, 2),
    'utf8'
  );
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const dashboardFixture = true;\n', 'utf8');

  execSync('git init -b main', { cwd: repoRoot, stdio: 'ignore' });
  execSync('git config user.name "Nexus Prime Dashboard Test"', { cwd: repoRoot, stdio: 'ignore' });
  execSync('git config user.email "nexus-prime-dashboard@test.local"', { cwd: repoRoot, stdio: 'ignore' });
  execSync('git add README.md package.json src/app.ts', { cwd: repoRoot, stdio: 'ignore' });
  execSync('git commit -m "fixture"', { cwd: repoRoot, stdio: 'ignore' });

  return repoRoot;
}

async function fetchStreamChunk(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.setEncoding('utf8');
      res.once('data', (chunk) => {
        req.destroy();
        resolve(String(chunk));
      });
      res.once('error', reject);
    });
    req.on('error', reject);
  });
}

async function waitForAddress(server: { getAddress(): string | null }, timeoutMs: number = 4000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const address = server.getAddress();
    if (address) {
      return address;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('dashboard did not publish an address in time');
}

async function startIncompatibleServer(port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>legacy dashboard</body></html>');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return server;
}

async function closeHttpServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  assert.ok(response.ok, `expected OK from ${url}, received ${response.status}`);
  return response.json();
}

function assertHealthContract(health: any, address: string): void {
  assert.strictEqual(health.dashboardApiVersion, '4', 'health should expose dashboard API version');
  assert.strictEqual(health.dashboardUrl, address, 'health should report the active dashboard URL');
  assert.strictEqual(health.capabilities.runs, true, 'runs capability should be advertised');
  assert.strictEqual(health.capabilities.memory, true, 'memory capability should be advertised');
  assert.strictEqual(health.capabilities.pod, true, 'pod capability should be advertised');
  assert.strictEqual(health.capabilities.clients, true, 'clients capability should be advertised');
  assert.strictEqual(health.capabilities.events, true, 'events capability should be advertised');
  assert.strictEqual(health.capabilities.stream, true, 'stream capability should be advertised');
  assert.strictEqual(health.capabilities.specialists, true, 'specialists capability should be advertised');
  assert.strictEqual(health.capabilities.crews, true, 'crews capability should be advertised');
  assert.strictEqual(health.capabilities.planner, true, 'planner capability should be advertised');
  assert.strictEqual(health.capabilities.hooks, true, 'hooks capability should be advertised');
  assert.strictEqual(health.capabilities.automations, true, 'automations capability should be advertised');
  assert.strictEqual(health.capabilities.federation, true, 'federation capability should be advertised');
  assert.strictEqual(health.capabilities.orchestration, true, 'orchestration capability should be advertised');
  assert.strictEqual(health.capabilities.tokens, true, 'tokens capability should be advertised');
  assert.strictEqual(health.capabilities.tokenSources, true, 'token-by-source capability should be advertised');
  assert.strictEqual(health.capabilities.clientPrimary, true, 'primary client capability should be advertised');
  assert.strictEqual(health.capabilities.instructionPacket, true, 'instruction packet capability should be advertised');
  assert.strictEqual(health.capabilities.orchestrationLedger, true, 'orchestration ledger capability should be advertised');
  assert.strictEqual(health.capabilities.knowledgeFabric, true, 'knowledge-fabric capability should be advertised');
  assert.strictEqual(health.capabilities.ragCollections, true, 'RAG collection capability should be advertised');
  assert.strictEqual(health.capabilities.patterns, true, 'pattern capability should be advertised');
  assert.strictEqual(health.capabilities.modelTiers, true, 'model-tier capability should be advertised');
  assert.strictEqual(health.capabilities.workerPlan, true, 'worker-plan capability should be advertised');
  assert.strictEqual(health.capabilities.artifactOutcomes, true, 'artifact-outcome capability should be advertised');
  assert.strictEqual(health.capabilities.memoryTrace, true, 'memory-trace capability should be advertised');
  assert.strictEqual(health.capabilities.memoryShared, true, 'shared-memory capability should be advertised');
  assert.strictEqual(health.capabilities.worktreeHealth, true, 'worktree-health capability should be advertised');
  assert.strictEqual(health.capabilities.featureRegistry, true, 'feature-registry capability should be advertised');
  assert.strictEqual(health.capabilities.synapse, true, 'synapse capability should be advertised');
  assert.strictEqual(health.capabilities.architects, true, 'architects capability should be advertised');
  assert.strictEqual(health.capabilities.dashboardSummary, true, 'dashboard summary capability should be advertised');
  assert.strictEqual(health.capabilities.dashboardSurfaces, true, 'dashboard surface capability should be advertised');
  assert.strictEqual(health.capabilities.nexusLayer, true, 'nexus layer capability should be advertised');
}

async function test() {
  console.log('🧪 Testing dashboard topology console...\n');

  const repoRoot = setupFixtureRepo();
  const port = 4400 + Math.floor(Math.random() * 400);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-prime-dashboard-state-'));
  const memoryDbPath = path.join(stateDir, 'memory.db');

  process.env.NEXUS_DASHBOARD_PORT = String(port);
  process.env.NEXUS_DASHBOARD_DISABLED = '0';
  process.env.NEXUS_STATE_DIR = stateDir;
  process.env.NEXUS_MEMORY_DB_PATH = memoryDbPath;
  process.env.HOME = path.join(stateDir, '.home');
  process.env.USERPROFILE = process.env.HOME;
  fs.mkdirSync(process.env.HOME, { recursive: true });
  process.env.CODEX_HOME = path.join(stateDir, '.codex');
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const eventsDir = path.join(process.env.HOME, '.nexus-prime');
  const eventsFile = path.join(eventsDir, 'events.jsonl');
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.writeFileSync(eventsFile, `${JSON.stringify({
    id: 'evt_rehydrated_dashboard',
    type: 'dashboard.action',
    timestamp: Date.now() - 5_000,
    data: {
      action: 'rehydrated-prestart',
      status: 'ok',
    },
  })}\n`, 'utf8');

  const { createSubAgentRuntime } = await import('../dist/phantom/index.js');
  const { createMemoryEngine } = await import('../dist/engines/memory.js');
  const { podNetwork } = await import('../dist/engines/pod-network.js');
  const { ClientRegistry } = await import('../dist/engines/client-registry.js');
  const { createOrchestrator } = await import('../dist/engines/orchestrator.js');
  const { SessionDNAManager } = await import('../dist/engines/session-dna.js');
  const { DashboardServer } = await import('../dist/dashboard/server.js');
  const { ensureBootstrap } = await import('../dist/engines/client-bootstrap.js');

  const readonlyStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-prime-readonly-memory-'));
  const readonlyDbDir = path.join(readonlyStateDir, 'readonly-db');
  fs.mkdirSync(readonlyDbDir, { recursive: true });
  fs.chmodSync(readonlyDbDir, 0o555);
  const fallbackMemory = createMemoryEngine(path.join(readonlyDbDir, 'memory.db'));
  const fallbackStatus = fallbackMemory.getStorageStatus();
  assert.strictEqual(fallbackStatus.fallbackApplied, true, 'memory engine should fall back when the requested DB path is readonly');
  assert.notStrictEqual(fallbackStatus.activeDbPath, fallbackStatus.requestedDbPath, 'memory engine should switch to a writable fallback DB path');
  fallbackMemory.store('Readonly fallback memory path smoke test', 0.7, ['#dashboard', '#fallback']);
  fallbackMemory.close();
  fs.chmodSync(readonlyDbDir, 0o755);

  const memory = createMemoryEngine(memoryDbPath);
  ensureBootstrap({ packageRoot: process.cwd(), workspaceRoot: repoRoot, phase: 'runtime', silent: true });
  const clientRegistry = new ClientRegistry();
  clientRegistry.recordHeartbeat('codex', { source: 'manual' });
  clientRegistry.recordDisconnect('claude-code', { source: 'manual' });

  const rootMemoryId = memory.store('Dashboard smoke memory root linked to exec_dashboard_run', 0.93, ['#dashboard', '#memory']);
  memory.store('Dashboard smoke child snapshot linked to workflow_dashboard_demo', 0.82, ['#dashboard', '#timeline'], rootMemoryId, 1);
  podNetwork.publish('worker-dashboard', 'Dashboard smoke pod signal', 0.88, ['#dashboard', '#pod']);

  const runtime = createSubAgentRuntime({ repoRoot, memory, artifactsRoot: path.join(stateDir, 'runs-primary') });
  const runtimeTwo = createSubAgentRuntime({ repoRoot, memory, artifactsRoot: path.join(stateDir, 'runs-secondary') });
  const orchestrator = createOrchestrator(memory, runtime, clientRegistry, new SessionDNAManager('dashboard-session-primary', path.join(stateDir, 'sessions')), repoRoot);
  const orchestratorTwo = createOrchestrator(memory, runtimeTwo, clientRegistry, new SessionDNAManager('dashboard-session-secondary', path.join(stateDir, 'sessions')), repoRoot);
  const ragCollection = orchestrator.createRagCollection({
    name: 'Dashboard RAG corpus',
    description: 'Ground dashboard orchestration with a session-scoped corpus',
    tags: ['dashboard', 'rag'],
    scope: 'session',
  });
  await orchestrator.ingestRagCollection(ragCollection.collectionId, [{
    text: 'Dashboard runs should expose runtime truth, knowledge fabric source mix, by-source token telemetry, and attached collection summaries.',
    label: 'dashboard-corpus',
    tags: ['dashboard', 'runtime-truth', 'tokens'],
  }]);
  orchestrator.attachRagCollection(ragCollection.collectionId);
  await runtime.run({
    goal: 'Create dashboard smoke artifacts',
    files: ['README.md', 'package.json'],
    workers: 1,
    verifyCommands: ['npm run build'],
    workflowSelectors: ['backend-execution-loop'],
    actions: [
      {
        type: 'append_file',
        path: 'README.md',
        content: '\nDashboard smoke run.\n'
      }
    ]
  });
  await runtimeTwo.planExecution({
    goal: 'Prepare a secondary runtime planning ledger',
    files: ['README.md'],
    crewSelectors: ['crew_implementation'],
    optimizationProfile: 'max',
  });
  await runtimeTwo.storeMemoryAndDispatch('Dashboard secondary runtime memory store', 0.91, ['#dashboard', '#runtime-two']);
  await orchestrator.orchestrate('Compile a dashboard instruction packet for the primary runtime', {
    files: ['README.md', 'package.json', 'src/app.ts'],
    workers: 1,
    verifyCommands: ['npm run build'],
    workflowSelectors: ['backend-execution-loop'],
    hookSelectors: ['run-created-brief'],
    automationSelectors: ['verified-followup-automation'],
    actions: [
      {
        type: 'append_file',
        path: 'README.md',
        content: '\nDashboard orchestrated run.\n'
      }
    ]
  });

  const makeServer = (runtimeProvider: any, orchestratorProvider: any) => new DashboardServer({
    runtimeProvider,
    orchestratorProvider,
    memoryProvider: () => memory,
    adaptersProvider: () => [],
    clientRegistryProvider: () => clientRegistry,
    repoRoot: process.cwd(),
  });

  const occupied = await startIncompatibleServer(port);

  try {
    const fallbackServer = makeServer(() => runtime, () => orchestrator);
    fallbackServer.start();
    const fallbackAddress = await waitForAddress(fallbackServer);
    assert.notStrictEqual(fallbackAddress, `http://127.0.0.1:${port}`, 'server should move to a new port when default port is occupied by an incompatible listener');

    const fallbackHealth = await fetchJson(`${fallbackAddress}/api/health`);
    assertHealthContract(fallbackHealth, fallbackAddress);

    fallbackServer.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    await closeHttpServer(occupied);
  }

  const primaryServer = makeServer(() => runtime, () => orchestrator);
  const reuseServer = makeServer(() => runtimeTwo, () => orchestratorTwo);
  primaryServer.start();

  try {
    const primaryAddress = await waitForAddress(primaryServer);
    assert.strictEqual(primaryAddress, `http://127.0.0.1:${port}`, 'primary dashboard should bind to the configured default port when free');

    reuseServer.start();
    const reusedAddress = await waitForAddress(reuseServer);
    assert.strictEqual(reusedAddress, primaryAddress, 'second dashboard instance should reuse the compatible dashboard listener');

    const [
      htmlRes,
      runsRes,
      skillsRes,
      workflowsRes,
      hooksRes,
      automationsRes,
      runtimesRes,
      usagePrimaryRes,
      usageSecondaryRes,
      orchestrationRes,
      ledgerRes,
      workerPlanRes,
      artifactOutcomesRes,
      packetRes,
      knowledgeFabricRes,
      knowledgeProvenanceRes,
      tokenSummaryRes,
      tokenTimelineRes,
      tokenSourcesRes,
      modelTiersRes,
      worktreeHealthRes,
      featureRegistryRes,
      synapseTeamsRes,
      synapseHealthRes,
      synapseApprovalsRes,
      architectsDispatchRes,
      architectsEscalationsRes,
      primaryClientRes,
      specialistsRes,
      crewsRes,
      ragCollectionsRes,
      patternsRes,
      backendsRes,
      healthRes,
      dashboardSummaryRes,
      surfaceOperateRes,
      surfaceMemoryRes,
      surfaceRunsRes,
      surfaceAssetsRes,
      surfaceTrustRes,
      dashboardEntityRes,
      memoryRes,
      memoryHealthRes,
      memoryTraceRes,
      memorySharedRes,
      memoryAuditRes,
      memoryQuarantineRes,
      memoryNetworkRes,
      podRes,
      clientsRes,
      federationRes,
      eventsRes,
    ] = await Promise.all([
      fetch(`${primaryAddress}/`),
      fetch(`${primaryAddress}/api/runs`),
      fetch(`${primaryAddress}/api/skills`),
      fetch(`${primaryAddress}/api/workflows`),
      fetch(`${primaryAddress}/api/hooks`),
      fetch(`${primaryAddress}/api/automations`),
      fetch(`${primaryAddress}/api/runtimes`),
      fetch(`${primaryAddress}/api/usage?runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/usage?runtimeId=${encodeURIComponent(runtimeTwo.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/orchestration/session`),
      fetch(`${primaryAddress}/api/orchestration/ledger?runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/orchestration/worker-plan?runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/orchestration/artifact-outcomes?runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/instruction-packet?runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/knowledge-fabric/session?runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/knowledge-fabric/provenance?runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/tokens/summary`),
      fetch(`${primaryAddress}/api/tokens/timeline?limit=5`),
      fetch(`${primaryAddress}/api/tokens/by-source?runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/models/tiers?runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/worktree-health?runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/feature-registry`),
      fetch(`${primaryAddress}/api/synapse/teams`),
      fetch(`${primaryAddress}/api/synapse/health`),
      fetch(`${primaryAddress}/api/synapse/approvals`),
      fetch(`${primaryAddress}/api/architects/dispatch`),
      fetch(`${primaryAddress}/api/architects/escalations`),
      fetch(`${primaryAddress}/api/clients/primary`),
      fetch(`${primaryAddress}/api/specialists`),
      fetch(`${primaryAddress}/api/crews`),
      fetch(`${primaryAddress}/api/rag/collections`),
      fetch(`${primaryAddress}/api/patterns/search?limit=5`),
      fetch(`${primaryAddress}/api/backends`),
      fetch(`${primaryAddress}/api/health`),
      fetch(`${primaryAddress}/api/dashboard/summary?runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/dashboard/surface/operate?runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/dashboard/surface/memory?runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/dashboard/surface/runs?runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/dashboard/surface/assets?runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/dashboard/surface/trust?runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/dashboard/entity?kind=memory&id=${encodeURIComponent(rootMemoryId)}&runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/memory`),
      fetch(`${primaryAddress}/api/memory/health`),
      fetch(`${primaryAddress}/api/memory/trace?id=${encodeURIComponent(rootMemoryId)}&runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/memory/shared?runtimeId=${encodeURIComponent(runtime.getRuntimeId())}`),
      fetch(`${primaryAddress}/api/memory/audit`),
      fetch(`${primaryAddress}/api/memory/quarantine`),
      fetch(`${primaryAddress}/api/memory/${encodeURIComponent(rootMemoryId)}/network`),
      fetch(`${primaryAddress}/api/pod`),
      fetch(`${primaryAddress}/api/clients`),
      fetch(`${primaryAddress}/api/federation`),
      fetch(`${primaryAddress}/api/events?limit=200`),
    ]);

    const html = await htmlRes.text();
    const runs = await runsRes.json();
    const skills = await skillsRes.json();
    const workflows = await workflowsRes.json();
    const hooks = await hooksRes.json();
    const automations = await automationsRes.json();
    const runtimes = await runtimesRes.json();
    const usagePrimary = await usagePrimaryRes.json();
    const usageSecondary = await usageSecondaryRes.json();
    const orchestration = await orchestrationRes.json();
    const ledger = await ledgerRes.json();
    const workerPlan = await workerPlanRes.json();
    const artifactOutcomes = await artifactOutcomesRes.json();
    const packet = await packetRes.json();
    const knowledgeFabric = await knowledgeFabricRes.json();
    const knowledgeProvenance = await knowledgeProvenanceRes.json();
    const tokenSummary = await tokenSummaryRes.json();
    const tokenTimeline = await tokenTimelineRes.json();
    const tokenSources = await tokenSourcesRes.json();
    const modelTiers = await modelTiersRes.json();
    const worktreeHealth = await worktreeHealthRes.json();
    const featureRegistry = await featureRegistryRes.json();
    const synapseTeams = await synapseTeamsRes.json();
    const synapseHealth = await synapseHealthRes.json();
    const synapseApprovals = await synapseApprovalsRes.json();
    const architectsDispatch = await architectsDispatchRes.json();
    const architectsEscalations = await architectsEscalationsRes.json();
    const primaryClient = await primaryClientRes.json();
    const specialists = await specialistsRes.json();
    const crews = await crewsRes.json();
    const ragCollections = await ragCollectionsRes.json();
    const patterns = await patternsRes.json();
    const backends = await backendsRes.json();
    const health = await healthRes.json();
    const dashboardSummary = await dashboardSummaryRes.json();
    const surfaceOperate = await surfaceOperateRes.json();
    const surfaceMemory = await surfaceMemoryRes.json();
    const surfaceRuns = await surfaceRunsRes.json();
    const surfaceAssets = await surfaceAssetsRes.json();
    const surfaceTrust = await surfaceTrustRes.json();
    const dashboardEntity = await dashboardEntityRes.json();
    const memories = await memoryRes.json();
    const memoryHealth = await memoryHealthRes.json();
    const memoryTrace = await memoryTraceRes.json();
    const memoryShared = await memorySharedRes.json();
    const memoryAudit = await memoryAuditRes.json();
    const memoryQuarantine = await memoryQuarantineRes.json();
    const memoryNetwork = await memoryNetworkRes.json();
    const pod = await podRes.json();
    const clients = await clientsRes.json();
    const federation = await federationRes.json();
    const events = await eventsRes.json();
    const streamChunk = await fetchStreamChunk(`${primaryAddress}/stream`);
    const cachedHealthAgain = await fetchJson(`${primaryAddress}/api/health`);
    const seedResponse = await fetch(`${primaryAddress}/api/skills/seed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then((response) => response.json());

    assert.ok(html.includes('Memory Explorer'), 'dashboard HTML should render the memory explorer shell');
    assert.ok(html.includes('Connected Ecosystem'), 'dashboard HTML should render restored ecosystem rail');
    assert.ok(html.includes('status-banner'), 'dashboard HTML should include compatibility banner shell');
    assert.ok(html.includes('data-surface-mode="operate"'), 'dashboard HTML should expose a top-level operate mode');
    assert.ok(html.includes('data-surface-mode="memory"'), 'dashboard HTML should expose a top-level memory mode');
    assert.ok(html.includes('data-surface-mode="runs"'), 'dashboard HTML should expose a top-level runs mode');
    assert.ok(html.includes('data-surface-mode="assets"'), 'dashboard HTML should expose a top-level assets mode');
    assert.ok(html.includes('data-surface-mode="trust"'), 'dashboard HTML should expose a top-level trust mode');
    assert.ok(html.includes('id="focus-overlay"'), 'dashboard HTML should expose the shared focus overlay shell');
    assert.ok(html.includes('id="focus-backdrop"'), 'dashboard HTML should expose the focus overlay backdrop');
    assert.ok(html.includes('data-focus-toggle="memory-graph"'), 'dashboard HTML should expose a graph focus control');
    assert.ok(html.includes('data-widget-id="memory-snapshots"'), 'dashboard HTML should expose memory snapshots as a focusable widget');
    assert.ok(html.includes('data-widget-id="events-panel"'), 'dashboard HTML should expose runtime events as a focusable widget');
    assert.ok(html.includes('data-widget-id="actions-panel"'), 'dashboard HTML should expose run controls as a focusable widget');
    assert.ok(html.includes('data-widget-id="token-source-card"'), 'dashboard HTML should expose the by-source token card as a focusable widget');
    assert.ok(html.includes('data-widget-id="token-phase-card"'), 'dashboard HTML should expose the by-phase token card as a focusable widget');
    assert.ok(html.includes('workspaceViews:'), 'dashboard HTML should track per-workspace view state');
    assert.ok(html.includes('data-library-mode="${escapeHtml(tab.mode)}"'), 'dashboard HTML should render secondary workspace tabs dynamically');
    assert.ok(!html.includes('data-library-mode="knowledge"'), 'dashboard HTML should not hardcode Knowledge inside the shared snapshots rail');
    assert.ok(!html.includes('data-library-mode="trust"'), 'dashboard HTML should not hardcode Trust inside the shared snapshots rail');
    assert.match(html, /operate:\s*\{[\s\S]*defaultLibraryMode:\s*'operate'[\s\S]*showGraph:\s*true/m, 'operate workspace should expose a guided default surface');
    assert.match(html, /memory:\s*\{[\s\S]*defaultLibraryMode:\s*'memories'[\s\S]*showGraph:\s*false/m, 'memory workspace should render as its own non-graph-first surface');
    assert.match(html, /runs:\s*\{[\s\S]*defaultLibraryMode:\s*'planning'[\s\S]*showGraph:\s*true/m, 'runs workspace should keep its own run-first center layout');
    assert.match(html, /assets:\s*\{[\s\S]*defaultLibraryMode:\s*'platform'[\s\S]*showGraph:\s*false/m, 'assets workspace should render inventory without the graph shell');
    assert.match(html, /trust:\s*\{[\s\S]*defaultLibraryMode:\s*'trust'[\s\S]*showGraph:\s*false/m, 'trust workspace should render as a non-graph-first center layout');
    assert.ok(html.includes('id="runtime-select"'), 'dashboard HTML should expose a runtime selector');
    assert.ok(html.includes('id="synapse-label"'), 'dashboard HTML should expose Synapse status in the header');
    assert.ok(html.includes('id="architects-label"'), 'dashboard HTML should expose Architects status in the header');
    assert.ok(html.includes('runtime-usage-summary'), 'dashboard HTML should expose runtime usage summary shell');
    assert.ok(html.includes('summary-chip'), 'dashboard HTML should render compact runtime summary chips');
    assert.ok(html.includes('id="plan-button"'), 'dashboard HTML should expose planner preview action');
    assert.ok(html.includes('id="execute-button"'), 'dashboard HTML should expose the primary execute action explicitly');
    assert.ok(html.includes('id="advanced-run-controls"'), 'dashboard HTML should collapse advanced run controls behind a details panel');
    assert.ok(html.includes('data-onboarding-task="memory-search"'), 'dashboard onboarding should expose a task-based entrypoint');
    assert.ok(html.includes('No persisted token telemetry for this runtime yet'), 'dashboard HTML should explain empty token telemetry state clearly');
    assert.ok(html.includes('Token Telemetry'), 'dashboard HTML should rename the token panel to a more concrete label');
    assert.ok(html.includes('Runtime Events'), 'dashboard HTML should rename the event stream panel to a more concrete label');
    assert.ok(html.includes('Run Controls'), 'dashboard HTML should rename the control-plane panel to a more concrete label');
    assert.ok(html.includes('Create / Ingest / Attach'), 'dashboard HTML should expose the explicit RAG collection workflow');
    assert.ok(html.includes('RAG Injection Path'), 'dashboard HTML should expose the RAG injection-path widget');
    assert.ok(html.includes('Used in Planner'), 'dashboard HTML should expose planner-stage RAG usage');
    assert.ok(html.includes('Used in Packet'), 'dashboard HTML should expose packet-stage RAG usage');
    assert.ok(html.includes('Used in Runtime'), 'dashboard HTML should expose runtime-stage RAG usage');
    assert.ok(html.includes('type="file"'), 'dashboard HTML should support local file ingestion for session RAG');
    assert.ok(html.includes('id="rag-url-input"'), 'dashboard HTML should support URL ingestion for session RAG');
    assert.ok(html.includes("details class=\"card\" ${collections.length ? '' : 'open'}"), 'knowledge workspace should auto-open the create form when no collections exist');
    assert.ok(html.includes('Lifetime compression'), 'dashboard HTML should label the token dial as lifetime compression');
    assert.ok(html.includes('data-memory-view-mode="graph" class="active"'), 'dashboard HTML should default the memory explorer back to graph mode');
    assert.ok(html.includes('data-memory-view-mode="clusters"'), 'dashboard HTML should keep layered memory explorer modes available');
    assert.ok(html.includes('id="library-tabs-wrap"'), 'dashboard HTML should wrap memory snapshot tabs in a horizontal scroll rail');
    assert.ok(html.includes('id="event-filters-wrap"'), 'dashboard HTML should wrap event filters in a compact horizontal rail');
    assert.ok(html.includes('data-event-filter="hooks"'), 'dashboard HTML should expose hooks event filter');
    assert.ok(html.includes('data-event-filter="automations"'), 'dashboard HTML should expose automations event filter');
    assert.ok(html.includes('data-event-filter="shield"'), 'dashboard HTML should expose shield event filter');
    assert.ok(html.includes('data-event-filter="federation"'), 'dashboard HTML should expose federation event filter');
    assert.match(html, /runtime:\s*\['runs', 'pod', 'usage', 'orchestrationSession', 'orchestrationLedger', 'instructionPacket', 'tokensSummary', 'tokensTimeline', 'tokensBySource'\]/, 'runtime-category refresh should include token resources');
    assert.match(html, /knowledge:\s*\['knowledgeFabricSession', 'knowledgeProvenance', 'ragCollections', 'patterns', 'tokensSummary', 'tokensTimeline', 'tokensBySource', 'modelTiers', 'memoryShared', 'usage'\]/, 'knowledge-category refresh should include token resources');
    assert.match(html, /refreshAll\(\['ragCollections', 'knowledgeFabricSession', 'knowledgeProvenance', 'usage', 'tokensSummary', 'tokensTimeline', 'tokensBySource', 'orchestrationSession', 'orchestrationLedger'\]\)/, 'RAG actions should refresh token telemetry alongside knowledge surfaces');
    assert.ok(html.includes("getDefaultRefreshTargets()"), 'dashboard client should load summary plus the active surface by default');
    assert.ok(html.includes("url: '/api/dashboard/summary'"), 'dashboard client should use the aggregated summary read model');
    assert.ok(html.includes("url: '/api/dashboard/surface/operate'"), 'dashboard client should use aggregated surface read models');
    assert.ok(html.includes('skipWhenStreamHealthy: true'), 'dashboard client should skip events refetch while SSE is healthy');
    assert.ok(html.includes('renderForTargets('), 'dashboard client should support lightweight section renders');
    assert.ok(html.includes('ttlMs: 15000'), 'dashboard client should assign TTLs to hot resources');
    assert.ok(html.includes("state.workspaceViews[state.surfaceMode] = button.dataset.libraryMode"), 'workspace-specific tabs should update the active workspace view');
    assert.ok(html.includes('height: 100vh;'), 'dashboard CSS should bind the shell to the viewport');
    assert.ok(html.includes('height: clamp(280px, 38vh, 420px);'), 'graph stage should have an explicit bounded height');
    assert.ok(html.includes('text-overflow: ellipsis;'), 'graph note should truncate with ellipsis to prevent text overflow into stats');
    assert.ok(html.includes('.focusable-shell:has(> .hidden:first-child)'), 'focusable shell should collapse gap when graph widget is hidden');
    assert.ok(!html.includes('margin-top: 1rem; min-height:'), 'memory-snapshots should not carry an inline margin-top that fights surface overrides');
    assert.ok(!html.includes('Auto-seed skills and workflows on first load'), 'dashboard bootstrap should not mutate runtime state on load');
    assert.ok(!html.includes("if (state.skills.length === 0)"), 'dashboard bootstrap should not auto-seed when skills are empty');
    assert.ok(html.includes('Refresh Catalog'), 'dashboard should demote dashboard-local seeding in favor of canonical runtime catalog refresh');
    assert.ok(!html.includes('Seed Defaults'), 'dashboard should not present shadow default seeding as the primary operator action');
    assert.ok(Array.isArray(runs) && runs.length > 0, 'runs API should return recorded runs');
    assert.ok(Array.isArray(skills) && skills.length > 0, 'skills API should return artifacts');
    assert.ok(Array.isArray(workflows) && workflows.length > 0, 'workflows API should return artifacts');
    assert.ok(Array.isArray(hooks) && hooks.length > 0, 'hooks API should return artifacts');
    assert.ok(Array.isArray(automations) && automations.length > 0, 'automations API should return artifacts');
    assert.ok(Array.isArray(runtimes) && runtimes.length >= 2, 'runtime registry API should return multiple live runtimes');
    assert.strictEqual(usagePrimary.runtimeId, runtime.getRuntimeId(), 'usage API should resolve the primary runtime');
    assert.strictEqual(usageSecondary.runtimeId, runtimeTwo.getRuntimeId(), 'usage API should resolve the secondary runtime');
    assert.strictEqual(usagePrimary.usage.skills.status, 'used', 'primary runtime usage should record skill usage');
    assert.strictEqual(usagePrimary.executionMode, 'autonomous', 'primary runtime usage should record autonomous orchestration mode');
    assert.strictEqual(usagePrimary.plannerApplied, true, 'primary runtime usage should record planner application');
    assert.strictEqual(usagePrimary.tokenOptimizationApplied, true, 'primary runtime usage should record token optimization application');
    assert.strictEqual(usagePrimary.orchestrateCalled, true, 'primary runtime usage should record orchestrate usage');
    assert.strictEqual(usagePrimary.bootstrapCalled, false, 'primary runtime should remain partial until bootstrap is observed');
    assert.strictEqual(usagePrimary.sequenceCompliance?.status, 'partial', 'primary runtime usage should surface partial client-sequence compliance');
    assert.ok(usagePrimary.catalogHealth, 'usage API should expose catalog health');
    assert.ok(usagePrimary.artifactSelectionAudit, 'usage API should expose artifact selection audit');
    assert.ok(usagePrimary.taskGraph?.phases?.length > 0, 'usage API should expose the task graph');
    assert.ok(usagePrimary.workerPlan?.totalWorkers > 0, 'usage API should expose the worker plan');
    assert.ok(Array.isArray(usagePrimary.artifactOutcome?.outcomes), 'usage API should expose artifact outcomes');
    assert.ok(typeof usagePrimary.ragUsageSummary?.attachedCollections === 'number', 'usage API should expose RAG usage summary');
    assert.ok(usagePrimary.memoryScopeUsage?.sharedContextCount >= 0, 'usage API should expose memory scope usage');
    assert.ok(Array.isArray(usagePrimary.memoryReconciliationSummary?.entries), 'usage API should expose memory reconciliation summary');
    assert.ok(usagePrimary.sourceAwareTokenBudget?.applied, 'usage API should expose source-aware token budgeting');
    assert.ok(usagePrimary.bootstrapManifestStatus?.clients?.length > 0, 'usage API should expose bootstrap manifest truth');
    assert.strictEqual(usageSecondary.usage.plan.status, 'used', 'secondary runtime usage should record planning usage');
    assert.strictEqual(usageSecondary.usage.memories.status, 'used', 'secondary runtime usage should record memory usage');
    assert.strictEqual(usageSecondary.plannerCalled, true, 'secondary runtime usage should record planner calls');
    assert.ok(orchestration.sessionId, 'orchestration session API should expose a session id');
    assert.strictEqual(ledger.executionMode, 'autonomous', 'orchestration ledger API should expose autonomous execution mode');
    assert.ok(Array.isArray(workerPlan.lanes) && workerPlan.lanes.length > 0, 'worker-plan API should expose planned lanes');
    assert.ok(Array.isArray(artifactOutcomes.outcomes), 'artifact-outcomes API should expose artifact outcome rows');
    assert.ok(Array.isArray(ledger.steps) && ledger.steps.some((step: any) => step.id === 'planner-selection' && step.status === 'completed'), 'orchestration ledger should include planner completion');
    assert.ok(Array.isArray(ledger.steps) && ledger.steps.some((step: any) => step.id === 'token-optimization' && step.status === 'completed'), 'orchestration ledger should include token optimization completion');
    assert.ok(Array.isArray(ledger.steps) && ledger.steps.some((step: any) => step.id === 'knowledge-fabric' && step.status === 'completed'), 'orchestration ledger should include knowledge fabric assembly');
    assert.ok(packet.packetHash, 'instruction packet API should expose the compiled packet hash');
    assert.ok(Array.isArray(packet.requiredSequence) && packet.requiredSequence.includes('compile-instruction-packet'), 'instruction packet API should expose the required execution sequence');
    assert.ok(Array.isArray(packet.protocol?.sources) && packet.protocol.sources.includes('AGENTS.md'), 'instruction packet API should report protocol sources');
    assert.ok(knowledgeFabric.sourceMix?.dominantSource, 'knowledge-fabric session API should expose source-mix decisions');
    assert.ok(Array.isArray(knowledgeProvenance.entries) && knowledgeProvenance.entries.length > 0, 'knowledge provenance API should expose bounded provenance entries');
    assert.ok(tokenSummary.totalRuns > 0, 'tokens summary API should expose persisted run telemetry');
    assert.ok(Array.isArray(tokenTimeline) && tokenTimeline.length > 0, 'tokens timeline API should expose recent runs');
    assert.ok(Object.keys(tokenSources).length > 0, 'token-by-source API should expose source allocation');
    assert.ok(Array.isArray(modelTiers.trace) && modelTiers.trace.length > 0, 'model-tier API should expose stage trace');
    assert.ok(typeof worktreeHealth.overall === 'string', 'worktree-health API should expose overall status');
    assert.ok(Array.isArray(featureRegistry.sections) && featureRegistry.sections.length > 0, 'feature-registry API should expose generated sections');
    assert.ok(Array.isArray(synapseTeams), 'synapse teams API should return a list');
    assert.ok(Array.isArray(synapseHealth), 'synapse health API should return a list');
    assert.ok(Array.isArray(synapseApprovals), 'synapse approvals API should return a list');
    assert.ok(typeof architectsDispatch === 'object' && architectsDispatch !== null, 'architects dispatch API should return an object');
    assert.ok(Array.isArray(architectsEscalations), 'architects escalations API should return a list');
    assert.strictEqual(primaryClient.clientId, 'codex', 'primary client API should prefer Codex when CODEX env is active');
    assert.strictEqual(primaryClient.state, 'primaryActive', 'primary client API should expose primary-active status');
    assert.ok(Array.isArray(specialists) && specialists.length > 20, 'specialists API should return the imported roster');
    assert.ok(Array.isArray(crews) && crews.length > 0, 'crews API should return crew templates');
    assert.ok(Array.isArray(ragCollections) && ragCollections.some((collection: any) => collection.collectionId === ragCollection.collectionId), 'RAG collections API should return session-first corpora');
    assert.ok(Array.isArray(patterns) && patterns.length > 0, 'pattern search API should return bounded pattern cards');
    assert.ok(backends.memory && backends.compression && backends.dsl, 'backends API should return grouped catalogs');
    assertHealthContract(health, primaryAddress);
    assertHealthContract(cachedHealthAgain, primaryAddress);
    assert.ok((health.runtime?.runtimeCount || 0) >= 2, 'health API should include runtime registry count');
    assert.strictEqual(health.docs.pagesWorkflowValid, true, 'health API should report fixed Pages workflow syntax');
    assert.strictEqual(cachedHealthAgain.release.packageVersion, health.release.packageVersion, 'health endpoint should return the same cached release metadata within the TTL window');
    assert.ok(health.memory?.storage, 'health API should expose memory storage status');
    assert.ok(typeof health.memory.storage.fallbackApplied === 'boolean', 'health API should surface whether memory storage fallback is active');
    assert.strictEqual(dashboardSummary.selectedRuntimeId, runtime.getRuntimeId(), 'dashboard summary should resolve the selected runtime');
    assert.ok(Array.isArray(dashboardSummary.runtimes) && dashboardSummary.runtimes.length >= 2, 'dashboard summary should include runtime choices');
    assert.ok(Array.isArray(dashboardSummary.alerts), 'dashboard summary should include operator alerts');
    assert.ok(dashboardSummary.backends?.memory, 'dashboard summary should include backend catalogs for first-load controls');
    assert.ok(dashboardSummary.nexusLayer?.domains?.knowledge, 'dashboard summary should expose the nexus layer knowledge domain');
    assert.strictEqual(dashboardSummary.tokenOptimization?.applied, true, 'dashboard summary should expose first-class token optimization truth');
    assert.ok(dashboardSummary.gateSummary && typeof dashboardSummary.gateSummary.total === 'number', 'dashboard summary should expose gate summary counts');
    assert.ok(dashboardSummary.memoryContainers?.byLane, 'dashboard summary should expose memory container counts');
    assert.ok(Array.isArray(dashboardSummary.interpretationIssues), 'dashboard summary should expose interpretation issues');
    assert.ok(Object.prototype.hasOwnProperty.call(dashboardSummary, 'preCompactionBackup'), 'dashboard summary should expose pre-compaction backup status');
    assert.ok(Array.isArray(surfaceOperate.runs) && surfaceOperate.runs.length > 0, 'operate surface should return run data');
    assert.ok(Array.isArray(surfaceOperate.memory) && surfaceOperate.memory.length > 0, 'operate surface should return recent memory');
    assert.strictEqual(surfaceOperate.tokenOptimization?.applied, true, 'operate surface should expose token optimization truth');
    assert.ok(surfaceOperate.gateSummary && typeof surfaceOperate.gateSummary.total === 'number', 'operate surface should expose gate summary counts');
    assert.ok(surfaceOperate.memoryContainers?.byLane, 'operate surface should expose memory containers');
    assert.ok(Array.isArray(surfaceOperate.interpretationIssues), 'operate surface should expose interpretation issues');
    assert.ok(surfaceMemory.nexusLayer?.domains?.reflection, 'memory surface should expose nexus layer reflection data');
    assert.ok(Array.isArray(surfaceMemory.ragCollections), 'memory surface should return context-source collections');
    assert.ok(Array.isArray(surfaceMemory.workspace), 'memory surface should expose workspace memories');
    assert.ok(Array.isArray(surfaceMemory.profile), 'memory surface should expose profile memories');
    assert.ok(Array.isArray(surfaceMemory.shared), 'memory surface should expose shared memories');
    assert.ok(Array.isArray(surfaceMemory.inbox), 'memory surface should expose inbox memories');
    assert.ok(surfaceMemory.qualitySummary && typeof surfaceMemory.qualitySummary.workspace === 'number', 'memory surface should expose quality summary');
    assert.ok(Array.isArray(surfaceRuns.runs) && surfaceRuns.runs.length > 0, 'runs surface should return recent runs');
    assert.ok(surfaceRuns.orchestrationLedger?.steps?.length > 0, 'runs surface should return the orchestration ledger');
    assert.ok(surfaceRuns.selectionAudit, 'runs surface should expose selection audit');
    assert.ok(Array.isArray(surfaceRuns.gateTimeline), 'runs surface should expose gate timeline');
    assert.ok(surfaceRuns.parallelism && typeof surfaceRuns.parallelism.totalWorkers === 'number', 'runs surface should expose bounded parallelism');
    assert.ok(Array.isArray(surfaceAssets.skills) && surfaceAssets.skills.length > 0, 'assets surface should return skill inventory');
    assert.ok(surfaceAssets.featureRegistry?.sections?.length > 0, 'assets surface should return the feature registry');
    assert.ok(surfaceAssets.selectionAudit, 'assets surface should expose asset-selection reasons');
    assert.ok(surfaceTrust.health?.memory?.storage, 'trust surface should surface health and storage state');
    assert.ok(surfaceTrust.federation && typeof surfaceTrust.federation === 'object', 'trust surface should return federation status');
    assert.ok(Array.isArray(surfaceTrust.interpretationIssues), 'trust surface should expose interpretation issues');
    assert.ok(Object.prototype.hasOwnProperty.call(surfaceTrust, 'preCompactionBackup'), 'trust surface should expose pre-compaction backup status');
    assert.strictEqual(dashboardEntity.id, rootMemoryId, 'dashboard entity read model should resolve a memory entity');
    assert.ok(Array.isArray(memories) && memories.length >= 2, 'memory API should return snapshots');
    assert.ok(typeof memoryHealth.total === 'number', 'memory health API should expose aggregate counts');
    assert.strictEqual(memoryTrace.id, rootMemoryId, 'memory trace API should resolve the requested memory');
    assert.ok(Array.isArray(memoryTrace.lineage), 'memory trace API should expose lineage');
    assert.ok(Array.isArray(memoryShared), 'shared-memory API should return shared memory rows');
    assert.ok(typeof memoryAudit.scanned === 'number', 'memory audit API should return a scan count');
    assert.ok(Array.isArray(memoryQuarantine), 'memory quarantine API should return a list');
    assert.ok(memoryAudit.findings.length > 0, 'memory audit API should expose governance findings');
    assert.ok(Array.isArray(memoryNetwork.nodes) && memoryNetwork.nodes.length > 0, 'memory network API should return graph nodes');
    assert.ok(Array.isArray(pod.messages) && pod.messages.length > 0, 'pod API should return messages');
    assert.ok(Array.isArray(clients) && clients.some((client: any) => client.clientId === 'codex' && client.state === 'primaryActive'), 'client API should mark Codex as the primary active client');
    assert.ok(Array.isArray(clients) && clients.some((client: any) => client.clientId === 'claude-code' && client.state === 'idle'), 'client API should keep stale Claude presence below the active Codex session');
    assert.ok(Array.isArray(clients) && clients.some((client: any) => client.clientId === 'antigravity' && client.state === 'installed'), 'client API should keep Antigravity visible when bootstrap is configured');
    assert.ok(Array.isArray(federation.knownPeers), 'federation API should return peer inventory');
    assert.ok(federation.relay && typeof federation.relay.configured === 'boolean', 'federation API should expose relay status');
    assert.ok(Array.isArray(hooks) && hooks.some((hook: any) => hook.trigger), 'hooks API should expose trigger metadata');
    assert.ok(Array.isArray(automations) && automations.some((automation: any) => automation.triggerMode), 'automations API should expose trigger metadata');
    assert.ok(Array.isArray(events) && events.length > 0, 'events API should return normalized event cards');
    assert.ok(events.some((event: any) => event.type === 'dashboard.action' && String(event.summary).includes('rehydrated-prestart')), 'events API should rehydrate recent persisted events on dashboard start');
    assert.ok(events.every((event: any) => event.title && event.category && typeof event.time === 'number'), 'events API should normalize event cards');
    assert.ok(streamChunk.includes('retry: 3000') || streamChunk.includes('event: bootstrap'), 'stream endpoint should emit SSE prelude');
    assert.strictEqual(seedResponse.mode, 'canonical-runtime', 'seed endpoint should report canonical runtime catalog mode');
    assert.deepStrictEqual(seedResponse.seeded, [], 'seed endpoint should avoid dashboard-local artifact mutation');

    const deploySkill = await fetch(`${primaryAddress}/api/skills/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillId: skills[0].skillId }),
    });
    const deployWorkflow = await fetch(`${primaryAddress}/api/workflows/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: workflows[0].workflowId }),
    });
    const deployHook = await fetch(`${primaryAddress}/api/hooks/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hookId: hooks[0].hookId }),
    });
    const deployAutomation = await fetch(`${primaryAddress}/api/automations/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ automationId: automations[0].automationId }),
    });
    const executeRun = await fetch(`${primaryAddress}/api/runtime/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: 'Dashboard control plane run',
        files: ['README.md'],
        workers: 1,
        crewSelectors: ['crew_implementation'],
        specialistSelectors: [specialists[0].specialistId],
        optimizationProfile: 'standard',
        verifyCommands: ['npm run build'],
        hookSelectors: ['run-created-brief'],
        automationSelectors: ['verified-followup-automation'],
        actions: [{ type: 'append_file', path: 'README.md', content: '\nControl plane run.\n' }]
      }),
    });
    const planRun = await fetch(`${primaryAddress}/api/runtime/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: 'Plan a dashboard runtime task',
        files: ['README.md'],
        crewSelectors: ['crew_implementation'],
        specialistSelectors: [specialists[0].specialistId],
        optimizationProfile: 'max',
      }),
    });
    const runAutomation = await fetch(`${primaryAddress}/api/automations/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ automationId: automations[0].automationId, goal: 'Dashboard automation smoke run' }),
    });
    const reconnectClient = await fetch(`${primaryAddress}/api/clients/codex/reconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const tokenRun = await fetch(`${primaryAddress}/api/tokens/runs/${encodeURIComponent(runs[0].runId)}`);

    assert.strictEqual(deploySkill.status, 200, 'skill deploy route should succeed');
    assert.strictEqual(deployWorkflow.status, 200, 'workflow deploy route should succeed');
    assert.strictEqual(deployHook.status, 200, 'hook deploy route should succeed');
    assert.strictEqual(deployAutomation.status, 200, 'automation deploy route should succeed');
    assert.strictEqual(planRun.status, 200, 'runtime plan route should succeed');
    assert.strictEqual(executeRun.status, 201, 'runtime execute route should create a run');
    assert.strictEqual(runAutomation.status, 201, 'automation run route should create a run');
    assert.strictEqual(reconnectClient.status, 200, 'client reconnect route should succeed');
    assert.strictEqual(tokenRun.status, 200, 'token run drilldown route should resolve persisted per-run telemetry');

    const planned = await planRun.json();
    const executed = await executeRun.json();
    const tokenRunPayload = await tokenRun.json();
    assert.ok(planned.selectedCrew?.crewId, 'runtime plan should expose selected crew');
    assert.ok(Array.isArray(planned.selectedSpecialists), 'runtime plan should expose specialists');
    assert.ok(Array.isArray(planned.ledger) && planned.ledger.length > 0, 'runtime plan should expose live ledger rows');
    assert.ok(executed.plannerState?.selectedCrew?.crewId, 'dashboard execute should route through the orchestrator and return planner state');
    assert.strictEqual(tokenRunPayload.runId, runs[0].runId, 'token run drilldown should match the requested run');

    console.log('✅ Dashboard compatibility, APIs, topology shell, and control plane are healthy\n');

    const registryDir = path.join(stateDir, 'runtime-registry');
    const primarySnapshotPath = path.join(registryDir, `${runtime.getRuntimeId()}.json`);
    const snapshot = JSON.parse(fs.readFileSync(primarySnapshotPath, 'utf8'));
    assert.strictEqual(snapshot.executionMode, 'manual-low-level', 'runtime registry snapshot should mark explicit low-level automation runs as manual');
    assert.ok(Array.isArray(snapshot.executionLedger?.steps), 'runtime registry snapshot should persist the latest execution ledger');
    assert.ok(snapshot.executionLedger.steps.some((step: any) => step.id === 'compile-instruction-packet' && step.status === 'skipped' && step.reason === 'manual-low-level'), 'manual execution snapshots should preserve packet bypass reasons');
    assert.ok(Array.isArray(snapshot.lastToolCalls), 'runtime registry snapshot should persist the recent client tool chain');
    assert.ok(snapshot.sequenceCompliance?.status, 'runtime registry snapshot should persist sequence compliance');
    snapshot.lastHeartbeatAt = Date.now() - (5 * 60 * 1000);
    fs.writeFileSync(primarySnapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
    const staleRuntimes = await fetchJson(`${primaryAddress}/api/runtimes`);
    const stalePrimary = staleRuntimes.find((entry: any) => entry.runtimeId === runtime.getRuntimeId());
    assert.strictEqual(stalePrimary.health, 'stale', 'runtime registry should mark stale snapshots explicitly');
  } finally {
    reuseServer.stop();
    primaryServer.stop();
    memory.close();
    delete process.env.NEXUS_DASHBOARD_PORT;
    delete process.env.NEXUS_DASHBOARD_DISABLED;
    delete process.env.NEXUS_STATE_DIR;
    delete process.env.NEXUS_MEMORY_DB_PATH;
    delete process.env.CODEX_HOME;
  }
}

test().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
