import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { nexusEventBus } from './event-bus.js';
import { ByzantineConsensus, type ConsensusResult } from './byzantine-consensus.js';
import { resolveNexusStateDir } from './runtime-registry.js';

export interface PodGroup {
    id: string;
    leadWorkerId: string;
    workerIds: string[];
    progress: number;
}

export interface PodMessage {
    id: string;
    workerId: string;
    type: 'observation' | 'fact' | 'instruction';
    content: string;
    timestamp: number;
    tags: string[];
    confidence: number;
}

export interface PodWorkerSnapshot {
    workerId: string;
    lastMessageTimestamp: number;
    messageCount: number;
    avgConfidence: number;
    state: 'active' | 'idle';
    tags: string[];
}

export interface PodDashboardSnapshot {
    lastMessageTimestamp: number | null;
    messages: PodMessage[];
    tagClusters: Array<{ tag: string; count: number }>;
    activeWorkers: PodWorkerSnapshot[];
    confidenceBands: {
        high: number;
        medium: number;
        low: number;
    };
}

export class PODNetwork {
    private messages: PodMessage[] = [];
    private subscribers: Map<string, Set<(msg: PodMessage) => void>> = new Map();
    private podGroups: Map<string, PodGroup> = new Map();
    public consensus: ByzantineConsensus = new ByzantineConsensus();
    private podPath: string;
    private pollHandle: ReturnType<typeof setInterval> | null = null;
    public static instance: PODNetwork;

    constructor() {
        PODNetwork.instance = this;
        this.podPath = resolvePodPath();
        this.loadMessages();

        // Basic poll for changes from other workers (cross-process)
        // unref() allows the Node process to exit even if the timer is still active
        this.pollHandle = setInterval(() => this.loadMessages(), 5000);
        this.pollHandle.unref();
    }

    private loadMessages(): void {
        try {
            if (fs.existsSync(this.podPath)) {
                const data = fs.readFileSync(this.podPath, 'utf-8');
                if (!data) return;

                const fileMessages: PodMessage[] = JSON.parse(data);

                // Merge and deduplicate by ID
                const existingIds = new Set(this.messages.map(m => m.id));
                const newMessages = fileMessages.filter(m => !existingIds.has(m.id));

                if (newMessages.length > 0) {
                    this.messages.push(...newMessages);
                    // Broadcast new findings to local subscribers
                    newMessages.forEach(m => this.broadcast(m));
                }
            }
        } catch (e) {
            // Ignore parse/read errors if file is being written
        }
    }

    private saveMessages(): void {
        try {
            // TTL: Only keep messages from the last 1 hour to prevent file bloat
            const oneHourAgo = Date.now() - (60 * 60 * 1000);
            this.messages = this.messages.filter(m => m.timestamp > oneHourAgo);

            fs.writeFileSync(this.podPath, JSON.stringify(this.messages, null, 2));
        } catch (e) {
            console.error('Failed to save POD messages:', e);
        }
    }

    /** Publish a finding to the network */
    publish(workerId: string, content: string, confidence: number = 0.8, tags: string[] = []): PodMessage {
        const msg: PodMessage = {
            id: randomUUID(),
            workerId,
            content,
            confidence,
            tags,
            timestamp: Date.now(),
            type: tags.includes('#instruction') ? 'instruction' : 'observation'
        };

        this.messages.push(msg);
        this.saveMessages();
        this.broadcast(msg);
        return msg;
    }

    /** Recall relevant POD context for a specific task */
    recall(tags: string[], minConfidence: number = 0.5): PodMessage[] {
        this.loadMessages(); // Refresh from file before recall
        return this.messages.filter(m =>
            m.confidence >= minConfidence &&
            (tags.length === 0 || tags.some(t => m.tags.includes(t)))
        ).sort((a, b) => b.timestamp - a.timestamp);
    }

    getMessages(limit: number = 40): PodMessage[] {
        this.loadMessages();
        return [...this.messages]
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, Math.max(limit, 1));
    }

    getWorker(workerId: string, limit: number = 20): PodWorkerSnapshot & { messages: PodMessage[] } {
        const messages = this.getMessages(Math.max(limit * 2, 20)).filter((message) => message.workerId === workerId).slice(0, limit);
        const tags = [...new Set(messages.flatMap((message) => message.tags))].slice(0, 8);
        const avgConfidence = messages.length
            ? messages.reduce((sum, message) => sum + message.confidence, 0) / messages.length
            : 0;
        const lastMessageTimestamp = messages[0]?.timestamp ?? 0;

        return {
            workerId,
            lastMessageTimestamp,
            messageCount: messages.length,
            avgConfidence,
            state: lastMessageTimestamp && Date.now() - lastMessageTimestamp < 10 * 60 * 1000 ? 'active' : 'idle',
            tags,
            messages,
        };
    }

    getDashboardSnapshot(limit: number = 40): PodDashboardSnapshot {
        const messages = this.getMessages(limit);
        const tagCounts = new Map<string, number>();
        const workerMessages = new Map<string, PodMessage[]>();

        for (const message of messages) {
            for (const tag of message.tags) {
                tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
            }
            const bucket = workerMessages.get(message.workerId) ?? [];
            bucket.push(message);
            workerMessages.set(message.workerId, bucket);
        }

        const activeWorkers: PodWorkerSnapshot[] = [...workerMessages.entries()]
            .map(([workerId, entries]) => {
                const lastMessageTimestamp = entries[0]?.timestamp ?? 0;
                return {
                    workerId,
                    lastMessageTimestamp,
                    messageCount: entries.length,
                    avgConfidence: entries.reduce((sum, message) => sum + message.confidence, 0) / entries.length,
                    state: (Date.now() - lastMessageTimestamp < 10 * 60 * 1000 ? 'active' : 'idle') as 'active' | 'idle',
                    tags: [...new Set(entries.flatMap((message) => message.tags))].slice(0, 8),
                };
            })
            .sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp);

        return {
            lastMessageTimestamp: messages[0]?.timestamp ?? null,
            messages,
            tagClusters: [...tagCounts.entries()]
                .map(([tag, count]) => ({ tag, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 12),
            activeWorkers,
            confidenceBands: {
                high: messages.filter((message) => message.confidence >= 0.85).length,
                medium: messages.filter((message) => message.confidence >= 0.6 && message.confidence < 0.85).length,
                low: messages.filter((message) => message.confidence < 0.6).length,
            },
        };
    }

    /** Internal broadcast to active sub-agent listeners */
    private broadcast(msg: PodMessage): void {
        nexusEventBus.emit('pod.signal', {
            workerId: msg.workerId,
            type: msg.type,
            content: msg.content.substring(0, 50) + (msg.content.length > 50 ? '...' : ''),
            confidence: msg.confidence,
            tags: msg.tags,
        });

        for (const tag of msg.tags) {
            this.subscribers.get(tag)?.forEach(cb => cb(msg));
        }
        // Universal subscriber
        this.subscribers.get('*')?.forEach(cb => cb(msg));
    }

    /** Sub-agents can listen for specific events/topics */
    subscribe(tag: string, callback: (msg: PodMessage) => void): () => void {
        if (!this.subscribers.has(tag)) {
            this.subscribers.set(tag, new Set());
        }
        this.subscribers.get(tag)!.add(callback);

        return () => {
            this.subscribers.get(tag)?.delete(callback);
        };
    }

    clear(): void {
        this.messages = [];
        this.podGroups.clear();
        if (fs.existsSync(this.podPath)) {
            fs.unlinkSync(this.podPath);
        }
    }

    /** Create a new POD group containing 5-8 workers with a lead */
    createPodGroup(leadWorkerId: string, workerIds: string[]): string {
        const id = randomUUID();
        this.podGroups.set(id, { id, leadWorkerId, workerIds, progress: 0 });
        
        // Register agents in consensus for conflict resolution
        this.consensus.registerAgent(leadWorkerId);
        for (const w of workerIds) {
            this.consensus.registerAgent(w);
        }
        return id;
    }

    getPodGroup(podId: string): PodGroup | undefined {
        return this.podGroups.get(podId);
    }

    updatePodProgress(podId: string, progress: number): void {
        const pod = this.podGroups.get(podId);
        if (pod) {
            pod.progress = Math.max(0, Math.min(100, progress));
        }
    }

    getPodProgress(podId: string): number {
        return this.podGroups.get(podId)?.progress ?? 0;
    }

    /** Resolve inter-pod conflict using byzantine consensus */
    resolveConflict(proposerId: string, layerIndex: number, delta: number[]): ConsensusResult {
        return this.consensus.autoConsensus(proposerId, layerIndex, delta);
    }

    /** Stop the poll timer and release resources */
    destroy(): void {
        if (this.pollHandle) {
            clearInterval(this.pollHandle);
            this.pollHandle = null;
        }
    }
}

export const podNetwork = new PODNetwork();

function resolvePodPath(): string {
    const configured = process.env.NEXUS_POD_PATH;
    if (configured) {
        fs.mkdirSync(path.dirname(configured), { recursive: true });
        return configured;
    }

    return path.join(resolveNexusStateDir(), 'pod.json');
}
