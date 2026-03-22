import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// Types & Interfaces
// ─────────────────────────────────────────────────────────────────────────────

export type NexusEventType =
    | 'system.boot'
    | 'planner.stage'
    | 'memory.store'
    | 'memory.recall'
    | 'memory.flushed'
    | 'memory.health.tick'
    | 'pod.signal'
    | 'tokens.optimized'
    | 'phantom.worker.start'
    | 'phantom.worker.complete'
    | 'phantom.merge.complete'
    | 'phantom.merge'
    | 'guardrail.check'
    | 'ghost.pass'
    | 'graph.query'
    | 'graph.sync.failed'
    | 'graph.coverage.low'
    | 'darwin.cycle'
    | 'darwin.cycle.complete'
    | 'session.dna'
    | 'skill.register'
    | 'skill.deploy'
    | 'skill.revoke'
    | 'hook.deploy'
    | 'hook.revoke'
    | 'hook.fire'
    | 'workflow.deploy'
    | 'workflow.run'
    | 'automation.deploy'
    | 'automation.revoke'
    | 'automation.run'
    | 'shield.decision'
    | 'memory.audit'
    | 'federation.heartbeat'
    | 'client.heartbeat'
    | 'client.inferred'
    | 'client.status'
    | 'dashboard.action'
    | 'nexus.shutdown'
    | 'orchestrator.disposed'
    | 'nexusnet.publish'
    | 'nexusnet.sync'
    | 'mcp.call.start'
    | 'mcp.call.stream'
    | 'mcp.call.complete'
    // Phase 1A: Memory Compaction Flush
    | 'memory.pre-compaction'
    | 'memory.flush-requested'
    // Phase 9A: Quantum-Inspired Entanglement
    | 'entanglement.create'
    | 'entanglement.collapse'
    | 'entanglement.correlate'
    // Phase 9B: Continuous Attention Streams
    | 'cas.encode'
    | 'cas.decode'
    | 'cas.pattern_learned'
    // Phase 9C: AdaptiveKV Bridge
    | 'kv.merge'
    | 'kv.adapt'
    | 'kv.consensus'
    // Synapse
    | 'synapse.ready'
    | 'synapse.operative.hired'
    | 'synapse.operative.retired'
    | 'synapse.operative.health.changed'
    | 'synapse.striketeam.deployed'
    | 'synapse.striketeam.completed'
    | 'synapse.mission.assigned'
    | 'synapse.mission.completed'
    | 'synapse.sortie.started'
    | 'synapse.sortie.completed'
    | 'synapse.sortie.failed'
    | 'synapse.fieldreport.submitted'
    | 'synapse.echo.fired'
    | 'synapse.budget.warning'
    | 'synapse.budget.exceeded'
    | 'synapse.approval.requested'
    | 'synapse.approval.resolved'
    | 'synapse.compaction.standdown'
    | 'synapse.compaction.resumed'
    | 'synapse.watchdog.stall'
    | 'synapse.watchdog.zombie'
    // Architects
    | 'architects.ready'
    | 'architects.blueprint.instantiated'
    | 'architects.worklist.created'
    | 'architects.workitem.claimed'
    | 'architects.workitem.completed'
    | 'architects.workitem.blocked'
    | 'architects.constructionlock.acquired'
    | 'architects.constructionlock.released'
    | 'architects.constructionlock.contested'
    | 'architects.relay.sent'
    | 'architects.relay.read'
    | 'architects.sentinel.patrol'
    | 'architects.sentinel.stall'
    | 'architects.sentinel.zombie'
    | 'architects.ward.patrol'
    | 'architects.ward.escalation'
    | 'architects.convergence.started'
    | 'architects.convergence.merged'
    | 'architects.convergence.failed'
    | 'architects.dispatch.go'
    | 'architects.dispatch.queued'
    | 'ledger.duplicate-prevented'
    | 'nexus.circuit-open'
    | 'nexus.circuit-tripped';

export interface NexusEventPayloads {
    'system.boot': { version: string; toolsCount: number };
    'planner.stage': { runId?: string; stage: string; status: string; owner: string; assets: number };
    'memory.store': { id: string; priority: number; tags: string[]; tier: string };
    'memory.recall': { query: string; count: number };
    'memory.flushed': { count: number; reason: string; ts: number };
    'memory.health.tick': { counts: Array<{ state: string; c: number }>; ts: number };
    'pod.signal': { workerId: string; type: string; content: string; confidence?: number; tags?: string[] };
    'tokens.optimized': {
        savings: number;
        pct: number;
        files: number;
        inputTokens?: number;
        outputTokens?: number;
        compressionRatio?: number;
        runId?: string;
        sessionId?: string;
        phase?: string;
        subsystem?: string;
    };
    'phantom.worker.start': { workerId: string; approach: string; goal: string };
    'phantom.worker.complete': { workerId: string; confidence: number };
    'phantom.merge.complete': { workerId: string; confidence: number };
    'phantom.merge': { action: string; winner: string };
    'guardrail.check': { action: string; passed: boolean; score: number };
    'ghost.pass': { task: string; risks: number; workers: number };
    'graph.query': { query: string; resultsCount: number };
    'graph.sync.failed': { reason: string; memoryId?: string; ts: number };
    'graph.coverage.low': { memCount: number; graphEntities: number };
    'darwin.cycle': { hypothesis: string; outcome: string };
    'darwin.cycle.complete': { id: string; outcome: string; targetFile: string };
    'session.dna': { sessionId: string; action: 'generated' | 'loaded' };
    'skill.register': { name: string; id: string };
    'skill.deploy': { skillId: string; scope: string; status: string };
    'skill.revoke': { skillId: string; status: string };
    'hook.deploy': { hookId: string; scope: string; status: string };
    'hook.revoke': { hookId: string; status: string };
    'hook.fire': { hookId: string; name: string; trigger: string; blocked: boolean };
    'workflow.deploy': { workflowId: string; scope: string; status: string };
    'workflow.run': { workflowId: string; runId: string; status: string };
    'automation.deploy': { automationId: string; scope: string; status: string };
    'automation.revoke': { automationId: string; status: string };
    'automation.run': { automationId: string; trigger: string; queued: boolean };
    'shield.decision': { target: string; stage: string; action: string; blocked: boolean };
    'memory.audit': { scanned: number; quarantined: number };
    'federation.heartbeat': { peerId: string; source: string; health: string; capabilities: number };
    'client.heartbeat': { clientId: string; displayName: string; source: string; state: string };
    'client.inferred': { clientId: string; displayName: string; source: string; state: string; evidence: string[] };
    'client.status': { clientId: string; displayName: string; previous: string; next: string; source: string };
    'dashboard.action': { action: string; status: string; target?: string };
    'nexus.shutdown': { signal: string };
    'orchestrator.disposed': { ts: number };
    'nexusnet.publish': { type: string; byteSize: number };
    'nexusnet.sync': { newItemsCount: number };
    'mcp.call.start': { callId: string; serverName: string; toolName: string; args: any };
    'mcp.call.stream': { callId: string; chunk: string };
    'mcp.call.complete': { callId: string; serverName: string; toolName: string; durationMs: number; resultByteSize: number; result?: any; error?: string };
    // Phase 1A
    'memory.pre-compaction': { tokensRemaining: number; reason: string; sessionAgeMinutes: number };
    'memory.flush-requested': { force: boolean; reason: string; itemsFlushed: number };
    // Phase 9A
    'entanglement.create': { stateId: string; agents: number; dimension: number; type: string };
    'entanglement.collapse': { stateId: string; agentId: string; strategy: number; probability: number; remainingAgents: number };
    'entanglement.correlate': { stateId: string; pairs: number; avgCorrelation: number };
    // Phase 9B
    'cas.encode': { inputTokens: number; outputTokens: number; compressionRatio: number };
    'cas.decode': { tokens: number };
    'cas.pattern_learned': { pattern: string; codebookSize: number };
    // Phase 9C
    'kv.merge': { layerPair: string; compressionRatio: number };
    'kv.adapt': { taskType: string; shots: number; adaptationTime: number };
    'kv.consensus': { agents: number; syncOverhead: number; conflicts: number };
    // Synapse
    'synapse.ready': { version: string };
    'synapse.operative.hired': { operativeId: string; name: string; skillId: string | null; strikeTeamId: string };
    'synapse.operative.retired': { operativeId: string };
    'synapse.operative.health.changed': { operativeId: string; healthState: string };
    'synapse.striketeam.deployed': { strikeTeamId: string; operativeCount: number; missionCount: number };
    'synapse.striketeam.completed': { strikeTeamId: string };
    'synapse.mission.assigned': { operativeId: string; missionId: string; title: string };
    'synapse.mission.completed': { missionId: string };
    'synapse.sortie.started': { sortieId: string; operativeId: string; missionId: string | null };
    'synapse.sortie.completed': { sortieId: string; operativeId: string; missionId: string | null; workItemId: string | null; status: string; tokensUsed: number };
    'synapse.sortie.failed': { sortieId: string; operativeId: string; error: string };
    'synapse.fieldreport.submitted': { fieldReportId: string; operativeId: string; status: string };
    'synapse.echo.fired': { operativeId: string; predecessorCount: number };
    'synapse.budget.warning': { operativeId: string; spentUsd: number; capUsd: number; pct: number };
    'synapse.budget.exceeded': { operativeId: string; spentUsd: number; capUsd: number };
    'synapse.approval.requested': { approvalId: string; operativeId: string; action: string };
    'synapse.approval.resolved': { approvalId: string; decision: string };
    'synapse.compaction.standdown': { operativesPaused: number };
    'synapse.compaction.resumed': { operativesResumed: number };
    'synapse.watchdog.stall': { operativeId: string };
    'synapse.watchdog.zombie': { operativeId: string };
    // Architects
    'architects.ready': { version: string };
    'architects.blueprint.instantiated': { blueprintId: string; worklistId: string; workItemCount: number };
    'architects.worklist.created': { worklistId: string; blueprintId: string };
    'architects.workitem.claimed': { workItemId: string; operativeId: string };
    'architects.workitem.completed': { workItemId: string; operativeId: string; status: string };
    'architects.workitem.blocked': { workItemId: string; operativeId: string; reason: string };
    'architects.constructionlock.acquired': { lockId: string; workItemId: string; operativeId: string };
    'architects.constructionlock.released': { lockId: string; workItemId: string; finalStatus: string };
    'architects.constructionlock.contested': { workItemId: string; byOperativeId: string; requestedBy: string };
    'architects.relay.sent': { messageId: string; from: string; target: string; toId: string; subject: string };
    'architects.relay.read': { messageId: string; byOperativeId: string };
    'architects.sentinel.patrol': { strikeTeamId: string; operativeReports: Array<Record<string, unknown>>; overallHealth: string; stalledCount: number; zombieCount: number; generatedAt: string };
    'architects.sentinel.stall': { operativeId: string; strikeTeamId: string };
    'architects.sentinel.zombie': { operativeId: string; strikeTeamId: string };
    'architects.ward.patrol': { teamsChecked: number };
    'architects.ward.escalation': { strikeTeamId: string; consecutiveCriticalPatrols: number; message: string; report?: unknown };
    'architects.convergence.started': { runId: string; worklistId: string; itemCount: number };
    'architects.convergence.merged': { runId: string; worklistId: string };
    'architects.convergence.failed': { runId: string; worklistId: string; error: string };
    'architects.dispatch.go': { operativeId: string; workItemId: string };
    'architects.dispatch.queued': { operativeId: string; workItemId: string; depth: number };
    'ledger.duplicate-prevented': { fingerprint: string; existingId: string };
    'nexus.circuit-open': { remainingMs: number; consecutiveFailures: number };
    'nexus.circuit-tripped': { consecutiveFailures: number };
}

export interface NexusEvent<T extends NexusEventType = NexusEventType> {
    id: string;
    type: T;
    timestamp: number;
    data: NexusEventPayloads[T];
}

// ─────────────────────────────────────────────────────────────────────────────
// EventBus Singleton with Cross-Process JSONL Bridge
// ─────────────────────────────────────────────────────────────────────────────

const EVENTS_FILE = path.join(os.homedir(), '.nexus-prime', 'events.jsonl');
const MAX_EVENT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EVENT_ARCHIVES = 3;

class EventBusEngine {
    private emitter = new EventEmitter();
    private history: NexusEvent[] = [];
    private readonly MAX_HISTORY = 1000;
    private seenIds = new Set<string>();
    private fileOffset = 0;
    private pollHandle: ReturnType<typeof setInterval> | null = null;

    constructor() {
        // Increase limit for many dashboard connections
        this.emitter.setMaxListeners(50);
        // Ensure directory exists
        const dir = path.dirname(EVENTS_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.rehydrateHistoryFromDisk();
    }

    /**
     * Emit a strongly-typed Nexus Prime event
     */
    emit<T extends NexusEventType>(type: T, data: NexusEventPayloads[T]): void {
        const event: NexusEvent<T> = {
            id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            type,
            timestamp: Date.now(),
            data
        };

        this.recordEvent(event);

        // Broadcast in-process
        this.emitter.emit('nexus_event', event);

        // Write to JSONL file for cross-process bridge
        try {
            this.rotateEventsFileIfNeeded();
            fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n');
        } catch { /* ignore write errors */ }
    }

    /**
     * Poll the JSONL file for events from other processes.
     * Call this from DashboardServer to bridge cross-process events.
     */
    startFilePolling(intervalMs: number = 2000): void {
        if (this.pollHandle) return;

        // Skip to end of file initially so we don't replay old events
        try {
            if (fs.existsSync(EVENTS_FILE)) {
                this.fileOffset = fs.statSync(EVENTS_FILE).size;
            }
        } catch { /* ignore */ }

        this.pollHandle = setInterval(() => {
            try {
                if (!fs.existsSync(EVENTS_FILE)) return;
                const stat = fs.statSync(EVENTS_FILE);
                if (stat.size <= this.fileOffset) {
                    // File was truncated or no new data
                    if (stat.size < this.fileOffset) this.fileOffset = 0;
                    return;
                }

                // Read only new bytes
                const fd = fs.openSync(EVENTS_FILE, 'r');
                const buf = Buffer.alloc(stat.size - this.fileOffset);
                fs.readSync(fd, buf, 0, buf.length, this.fileOffset);
                fs.closeSync(fd);

                // Ensure we only process complete lines (ending in \n)
                const chunk = buf.toString('utf-8');
                const lastNewline = chunk.lastIndexOf('\n');

                if (lastNewline === -1) {
                    // No complete line yet, wait for next tick
                    return;
                }

                const validChunk = chunk.substring(0, lastNewline);
                this.fileOffset += Buffer.byteLength(validChunk) + 1; // +1 for the newline

                // Parse JSONL lines
                const lines = validChunk.split('\n').filter(Boolean);
                for (const line of lines) {
                    try {
                        const event = JSON.parse(line) as NexusEvent;
                        if (!this.seenIds.has(event.id)) {
                            this.recordEvent(event);
                            // Broadcast to in-process listeners (SSE clients)
                            this.emitter.emit('nexus_event', event);
                        }
                    } catch { /* skip malformed lines */ }
                }
            } catch { /* ignore poll errors */ }
        }, intervalMs);
        this.pollHandle.unref();
    }

    /** Stop file polling */
    stopFilePolling(): void {
        if (this.pollHandle) {
            clearInterval(this.pollHandle);
            this.pollHandle = null;
        }
    }

    /**
     * Listen to all events (useful for SSE streams)
     */
    onEvent(handler: (event: NexusEvent) => void): () => void {
        this.emitter.on('nexus_event', handler);
        // Return an unsubscribe function
        return () => this.emitter.off('nexus_event', handler);
    }

    /**
     * Listen to specific event types
     */
    on<T extends NexusEventType>(type: T, handler: (data: NexusEventPayloads[T]) => void): () => void {
        const wrapper = (event: NexusEvent) => {
            if (event.type === type) {
                handler(event.data as NexusEventPayloads[T]);
            }
        };
        this.emitter.on('nexus_event', wrapper);
        return () => this.emitter.off('nexus_event', wrapper);
    }

    /**
     * Get historical events
     */
    getHistory(sinceTimestamp: number = 0): NexusEvent[] {
        return this.history.filter(e => e.timestamp > sinceTimestamp);
    }

    /**
     * Clear history
     */
    clear(): void {
        this.history = [];
        this.seenIds.clear();
    }

    private recordEvent(event: NexusEvent): void {
        this.history.push(event);
        this.seenIds.add(event.id);
        this.trimHistory();
    }

    private trimHistory(): void {
        if (this.history.length <= this.MAX_HISTORY) {
            return;
        }
        this.history = this.history.slice(-this.MAX_HISTORY);
        this.seenIds = new Set(this.history.map((event) => event.id));
    }

    private rehydrateHistoryFromDisk(): void {
        const files = [
            ...Array.from({ length: MAX_EVENT_ARCHIVES }, (_, index) => `${EVENTS_FILE}.${MAX_EVENT_ARCHIVES - index}`),
            EVENTS_FILE,
        ];
        for (const target of files) {
            if (!fs.existsSync(target)) continue;
            try {
                const lines = fs.readFileSync(target, 'utf8')
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean);
                for (const line of lines) {
                    try {
                        const event = JSON.parse(line) as NexusEvent;
                        if (!event?.id || this.seenIds.has(event.id)) continue;
                        this.recordEvent(event);
                    } catch {
                        // Skip malformed archived events.
                    }
                }
            } catch {
                // Ignore unreadable archives and keep runtime eventing alive.
            }
        }
    }

    private rotateEventsFileIfNeeded(): void {
        try {
            if (!fs.existsSync(EVENTS_FILE)) return;
            const size = fs.statSync(EVENTS_FILE).size;
            if (size < MAX_EVENT_FILE_BYTES) return;

            const oldestArchive = `${EVENTS_FILE}.${MAX_EVENT_ARCHIVES}`;
            if (fs.existsSync(oldestArchive)) {
                fs.unlinkSync(oldestArchive);
            }
            for (let index = MAX_EVENT_ARCHIVES - 1; index >= 1; index -= 1) {
                const current = `${EVENTS_FILE}.${index}`;
                const next = `${EVENTS_FILE}.${index + 1}`;
                if (fs.existsSync(current)) {
                    fs.renameSync(current, next);
                }
            }
            fs.renameSync(EVENTS_FILE, `${EVENTS_FILE}.1`);
        } catch {
            // Ignore rotation failures and continue writing to the active event file.
        }
    }
}

// Export a singleton instance
export const nexusEventBus = new EventBusEngine();
