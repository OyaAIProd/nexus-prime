export type MemoryCandidateKind =
    | 'fact'
    | 'decision'
    | 'failure-mode'
    | 'reuse-pattern'
    | 'file-map'
    | 'operator-preference';

export interface MemoryCandidateFact {
    kind: MemoryCandidateKind;
    content: string;
    tags: string[];
    confidence: number;
    ephemeral: boolean;
}

export type MemoryContainerLane = 'profile' | 'workspace' | 'shared' | 'inbox';

export interface MemoryProvenance {
    source: 'operator' | 'runtime' | 'worker' | 'imported' | 'system' | 'rag';
    sessionId?: string;
    runId?: string;
    workerId?: string;
    workspaceId?: string;
    repoId?: string;
    projectId?: string;
    lane?: MemoryContainerLane;
    containerTags?: string[];
    toolName?: string;
    references: string[];
    tags: string[];
    summary: string;
}

export type MemoryReconciliationAction = 'ADD' | 'UPDATE' | 'MERGE' | 'DELETE' | 'NONE' | 'QUARANTINE';

export interface MemoryReconciliationEntry {
    candidate: string;
    action: MemoryReconciliationAction;
    reason: string;
    relatedIds: string[];
    storedId?: string;
    expiresAt?: number;
}

export interface MemoryReconciliationSummary {
    generatedAt: number;
    actionCounts: Record<MemoryReconciliationAction, number>;
    entries: MemoryReconciliationEntry[];
}

export interface MemoryMaintenanceResult {
    generatedAt: number;
    expired: number;
    cooled: number;
    quarantined: number;
    scrapMarked: number;
    retained: number;
}

const STOP_WORDS = new Set([
    'with',
    'from',
    'this',
    'that',
    'then',
    'also',
    'into',
    'about',
    'when',
    'where',
    'which',
    'what',
]);

export function deriveCandidateFacts(content: string, tags: string[] = [], limit: number = 6): MemoryCandidateFact[] {
    const normalized = String(content || '').trim();
    if (!normalized) return [];

    const structured = looksStructured(normalized, tags);
    const segmentLimit = structured ? Math.max(1, limit) : Math.min(Math.max(1, limit), 2);
    const rawSegments = normalized
        .split(/\n+|(?<=[.!?;])\s+/)
        .map((segment) => segment.trim())
        .filter(Boolean);
    const segments = rawSegments
        .filter((segment) => segment.length >= 20)
        .filter((segment) => isMeaningfulSegment(segment, tags))
        .slice(0, segmentLimit);
    const baseSegments = segments.length > 0 ? segments : [normalized];

    const candidates = baseSegments.map((segment) => buildCandidate(segment, tags));
    return dedupeCandidates(candidates).slice(0, segmentLimit);
}

export function createEmptyReconciliationSummary(): MemoryReconciliationSummary {
    return {
        generatedAt: Date.now(),
        actionCounts: {
            ADD: 0,
            UPDATE: 0,
            MERGE: 0,
            DELETE: 0,
            NONE: 0,
            QUARANTINE: 0,
        },
        entries: [],
    };
}

export function createMemoryProvenance(input: Partial<MemoryProvenance> & { source: MemoryProvenance['source'] }): MemoryProvenance {
    return {
        source: input.source,
        sessionId: input.sessionId,
        runId: input.runId,
        workerId: input.workerId,
        workspaceId: input.workspaceId,
        repoId: input.repoId,
        projectId: input.projectId,
        lane: input.lane,
        containerTags: dedupeStrings(input.containerTags ?? []),
        toolName: input.toolName,
        references: dedupeStrings(input.references ?? []),
        tags: dedupeStrings(input.tags ?? []),
        summary: input.summary ?? `${input.source} memory event`,
    };
}

function inferCandidateKind(content: string, tags: string[]): MemoryCandidateKind {
    const lowered = content.toLowerCase();
    const haystack = `${lowered}\n${tags.join(' ').toLowerCase()}`;
    if (/(decision|choose|chose|approved|rejected|tradeoff|policy)/.test(haystack)) return 'decision';
    if (/(root cause|failure|bug|broken|regression|blocked|cause)/.test(haystack)) return 'failure-mode';
    if (/(pattern|reuse|template|playbook|heuristic)/.test(haystack)) return 'reuse-pattern';
    if (/(file map|entrypoint|boundary|module|path|contract|architecture)/.test(haystack)) return 'file-map';
    if (/(prefer|preference|likes|dislikes|wants|operator)/.test(haystack)) return 'operator-preference';
    return 'fact';
}

function mergeTags(tags: string[], kind: MemoryCandidateKind): string[] {
    const mappedTag = kind === 'failure-mode'
        ? '#failure-mode'
        : kind === 'reuse-pattern'
            ? '#reuse-pattern'
            : kind === 'operator-preference'
                ? '#operator-preference'
                : kind === 'file-map'
                    ? '#file-map'
                    : kind === 'decision'
                        ? '#decision'
                        : '#fact';
    return dedupeStrings([...tags, mappedTag]);
}

function buildCandidate(segment: string, tags: string[]): MemoryCandidateFact {
    const kind = inferCandidateKind(segment, tags);
    const lowered = segment.toLowerCase();
    const noisy = isTelemetryNoise(segment) || isLowSignalSegment(segment);
    const lane = inferLane(kind, lowered, tags, noisy);
    const durableSignal = /(root cause|because|caused by|decision|prefer|pattern|reuse|contract|architecture|verified|resolved|fixed|remember|always|never|repo|project|workspace)/i.test(segment);
    const confidence = Math.max(
        0.18,
        Math.min(
            0.97,
            0.34
                + (durableSignal ? 0.28 : 0)
                + (kind === 'decision' || kind === 'failure-mode' || kind === 'reuse-pattern' || kind === 'operator-preference' ? 0.12 : 0)
                + (tags.length > 0 ? 0.05 : 0)
                + (segment.length <= 220 ? 0.06 : -0.04)
                - (noisy ? 0.36 : 0)
                - (/temporary|for now|for this run|until verified|draft|placeholder|wip|follow-up/i.test(lowered) ? 0.12 : 0),
        ),
    );
    const laneTag = lane === 'profile'
        ? '#profile'
        : lane === 'workspace'
            ? '#workspace'
            : lane === 'shared'
                ? '#shared'
                : '#inbox';

    return {
        kind,
        content: segment,
        tags: mergeTags([laneTag, ...(noisy ? ['#quarantine'] : []), ...tags], kind),
        confidence: Number(confidence.toFixed(2)),
        ephemeral: noisy || /temporary|for now|for this run|until verified|draft|placeholder|wip|follow-up/i.test(lowered),
    } satisfies MemoryCandidateFact;
}

function inferLane(kind: MemoryCandidateKind, lowered: string, tags: string[], noisy: boolean): MemoryContainerLane {
    if (tags.includes('#shared') || tags.includes('#worker-shared')) return 'shared';
    if (noisy || tags.includes('#inbox') || tags.includes('#quarantine')) return 'inbox';
    if (tags.includes('#user') || /(preference|prefer|likes|dislikes|operator|user profile)/.test(lowered) || kind === 'operator-preference') {
        return 'profile';
    }
    return 'workspace';
}

function looksStructured(content: string, tags: string[]): boolean {
    return tags.some((tag) => ['#decision', '#root-cause', '#reuse-pattern', '#project', '#user', '#shared', '#structured-memory'].includes(tag))
        || /\n[-*]\s+/.test(content)
        || /\b(decision|root cause|preference|reuse pattern|file map|architecture)\b/i.test(content);
}

function isMeaningfulSegment(segment: string, tags: string[]): boolean {
    if (segment.length < 20) return false;
    if (isTelemetryNoise(segment)) return true;
    if (tags.some((tag) => ['#decision', '#root-cause', '#reuse-pattern', '#operator-preference', '#project', '#user', '#shared'].includes(tag))) return true;
    return /(decision|root cause|because|caused by|fixed by|preference|prefer|reuse|pattern|architecture|contract|boundary|verified|workspace|repo|project|memory)/i.test(segment)
        || /\b(file|module|path|service|workflow|hook|skill|run)\b/i.test(segment);
}

function isLowSignalSegment(segment: string): boolean {
    return /(too complex|confusing|looks wrong|fix it all|show it|signal analysis|token optimization doesn't work|this is garbage|everything is broken)/i.test(segment)
        || /^(called|run id|summary|crew|specialists|workers|review gate|token budget|plaintext)\b/i.test(segment.toLowerCase());
}

function isTelemetryNoise(segment: string): boolean {
    return /(orchestrated run failed|called nexus orchestrate|run id:|summary:|crew:|specialists:|worker\(s\)|review gate|token optimization applied|token budget|selected skills|selected workflows|using planner|execution ledger|prompt packet|source-aware budget|fetched .* endpoint)/i.test(segment);
}

function dedupeCandidates(values: MemoryCandidateFact[]): MemoryCandidateFact[] {
    const seen = new Set<string>();
    const result: MemoryCandidateFact[] = [];
    for (const value of values) {
        const key = value.content.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !STOP_WORDS.has(token)).join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(value);
    }
    return result;
}

function dedupeStrings(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}
