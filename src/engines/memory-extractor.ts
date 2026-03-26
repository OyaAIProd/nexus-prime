import { execFileSync } from 'child_process';
import {
    deriveCandidateFacts,
    type MemoryCandidateFact,
    type MemoryCandidateKind,
    type MemoryExtractionMode,
} from './memory-control-plane.js';
import { createMemoryContentFingerprint } from './memory-fingerprint.js';

export interface ExtractedMemoryFact extends MemoryCandidateFact {
    extractionMode: MemoryExtractionMode;
    reason: string;
    rawFingerprint: string;
}

export interface MemoryExtractionResult {
    facts: ExtractedMemoryFact[];
    extractionMode: MemoryExtractionMode;
    fallbackUsed: boolean;
    errors: string[];
    rawFingerprint: string;
}

export interface MemoryExtractorConfig {
    mode?: 'heuristic' | 'hybrid' | 'llm';
    command?: string;
    ollamaModel?: string;
    timeoutMs?: number;
    invoker?: (prompt: string) => string;
}

interface RawLlmFact {
    content?: unknown;
    kind?: unknown;
    confidence?: unknown;
    ephemeral?: unknown;
    reason?: unknown;
}

const VALID_KINDS: MemoryCandidateKind[] = [
    'fact',
    'decision',
    'failure-mode',
    'reuse-pattern',
    'file-map',
    'operator-preference',
];

export class MemoryExtractor {
    private readonly mode: 'heuristic' | 'hybrid' | 'llm';
    private readonly command?: string;
    private readonly ollamaModel?: string;
    private readonly timeoutMs: number;
    private readonly invoker?: (prompt: string) => string;

    constructor(config: MemoryExtractorConfig = {}) {
        this.mode = (
            config.mode
            ?? (process.env.NEXUS_MEMORY_EXTRACTOR_MODE as 'heuristic' | 'hybrid' | 'llm' | undefined)
            ?? 'hybrid'
        );
        this.command = config.command ?? process.env.NEXUS_MEMORY_EXTRACTOR_COMMAND ?? undefined;
        this.ollamaModel = config.ollamaModel ?? process.env.NEXUS_MEMORY_EXTRACTOR_OLLAMA_MODEL ?? undefined;
        this.timeoutMs = Math.max(250, Number(config.timeoutMs ?? process.env.NEXUS_MEMORY_EXTRACTOR_TIMEOUT_MS ?? 4_000));
        this.invoker = config.invoker;
    }

    extract(content: string, tags: string[] = [], limit: number = 2): MemoryExtractionResult {
        const normalizedLimit = Math.max(1, Math.min(3, limit));
        const rawFingerprint = createMemoryContentFingerprint(content);
        const errors: string[] = [];

        if (this.mode !== 'heuristic') {
            try {
                const raw = this.invokeLlm(this.buildPrompt(content, tags, normalizedLimit));
                const parsed = this.parseLlmResponse(raw);
                const facts = this.normalizeFacts(parsed, tags, normalizedLimit, rawFingerprint, 'llm');
                if (facts.length > 0) {
                    return {
                        facts,
                        extractionMode: 'llm',
                        fallbackUsed: false,
                        errors,
                        rawFingerprint,
                    };
                }
                errors.push('LLM extractor returned no usable facts.');
            } catch (error) {
                errors.push(error instanceof Error ? error.message : String(error));
            }
        }

        const fallbackFacts = this.heuristicFacts(content, tags, normalizedLimit, rawFingerprint);
        return {
            facts: fallbackFacts,
            extractionMode: 'heuristic',
            fallbackUsed: this.mode !== 'heuristic',
            errors,
            rawFingerprint,
        };
    }

    private heuristicFacts(content: string, tags: string[], limit: number, rawFingerprint: string): ExtractedMemoryFact[] {
        return deriveCandidateFacts(content, tags, limit).map((fact) => ({
            ...fact,
            extractionMode: 'heuristic',
            reason: 'Extracted via deterministic heuristic segmentation.',
            rawFingerprint,
        }));
    }

    private buildPrompt(content: string, tags: string[], limit: number): string {
        return [
            'Extract 1 to 3 atomic memory facts from the input.',
            'Return strict JSON only with this shape:',
            '{"facts":[{"content":"...", "kind":"fact|decision|failure-mode|reuse-pattern|file-map|operator-preference", "confidence":0.0, "ephemeral":false, "reason":"..."}]}',
            'Rules:',
            '- Facts must be short, durable, and independently useful.',
            '- Do not restate telemetry noise or procedural chatter.',
            '- Prefer stable decisions, failures, preferences, file maps, and verified facts.',
            `- Return at most ${limit} facts.`,
            `Tags: ${tags.join(', ') || 'none'}`,
            'Input:',
            content,
        ].join('\n');
    }

    private invokeLlm(prompt: string): string {
        if (this.invoker) {
            return this.invoker(prompt);
        }
        if (this.command) {
            return execFileSync('/bin/sh', ['-lc', this.command], {
                input: prompt,
                encoding: 'utf8',
                timeout: this.timeoutMs,
                maxBuffer: 1024 * 1024,
            }).trim();
        }
        if (this.ollamaModel) {
            return execFileSync('ollama', ['run', this.ollamaModel], {
                input: prompt,
                encoding: 'utf8',
                timeout: this.timeoutMs,
                maxBuffer: 1024 * 1024,
            }).trim();
        }
        throw new Error('No LLM extractor backend configured.');
    }

    private parseLlmResponse(raw: string): RawLlmFact[] {
        const trimmed = String(raw || '').trim();
        const cleaned = trimmed
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```$/i, '')
            .trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
            return parsed as RawLlmFact[];
        }
        if (Array.isArray(parsed?.facts)) {
            return parsed.facts as RawLlmFact[];
        }
        throw new Error('LLM extractor returned an unsupported JSON shape.');
    }

    private normalizeFacts(
        rawFacts: RawLlmFact[],
        tags: string[],
        limit: number,
        rawFingerprint: string,
        extractionMode: MemoryExtractionMode,
    ): ExtractedMemoryFact[] {
        const facts: ExtractedMemoryFact[] = [];
        const seen = new Set<string>();

        for (const rawFact of rawFacts.slice(0, limit * 2)) {
            const content = String(rawFact?.content ?? '').trim();
            if (!content) continue;
            const seed = deriveCandidateFacts(content, tags, 1)[0];
            if (!seed) continue;
            const fingerprint = createMemoryContentFingerprint(content);
            if (seen.has(fingerprint)) continue;
            seen.add(fingerprint);
            facts.push({
                ...seed,
                content,
                kind: VALID_KINDS.includes(rawFact.kind as MemoryCandidateKind)
                    ? rawFact.kind as MemoryCandidateKind
                    : seed.kind,
                confidence: clampConfidence(rawFact.confidence, seed.confidence),
                ephemeral: typeof rawFact.ephemeral === 'boolean' ? rawFact.ephemeral : seed.ephemeral,
                extractionMode,
                reason: typeof rawFact.reason === 'string' && rawFact.reason.trim()
                    ? rawFact.reason.trim()
                    : extractionMode === 'llm'
                        ? 'Extracted by configured LLM backend.'
                        : 'Extracted via deterministic heuristic segmentation.',
                rawFingerprint,
            });
            if (facts.length >= limit) {
                break;
            }
        }

        return facts;
    }
}

function clampConfidence(value: unknown, fallback: number): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(0.18, Math.min(0.98, numeric));
}
