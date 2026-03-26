import type { Embedder } from './embedder.js';

export interface SemanticScoreBreakdown {
    semantic: number;
    lexical: number;
    keywordCoverage: number;
    pathBoost: number;
    final: number;
    fallbackUsed: boolean;
}

export interface SemanticScoreInput {
    query: string;
    embedder: Embedder;
    queryVector?: number[];
    candidateText: string;
    candidateVector?: number[];
    lexicalTexts?: string[];
    pathText?: string;
    weights?: {
        semantic?: number;
        lexical?: number;
        path?: number;
    };
}

const DEFAULT_WEIGHTS = {
    semantic: 0.78,
    lexical: 0.17,
    path: 0.05,
};

export function tokenizeSemanticText(text: string): Set<string> {
    return new Set(
        String(text || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter((token) => token.length > 2),
    );
}

export function extractSemanticKeywords(text: string): string[] {
    return [...tokenizeSemanticText(text)];
}

export function computeSemanticScore(input: SemanticScoreInput): SemanticScoreBreakdown {
    const weights = { ...DEFAULT_WEIGHTS, ...input.weights };
    const queryVector = input.queryVector ?? input.embedder.embedSync(input.query);
    const candidateVector = input.candidateVector;
    const semantic = (
        Array.isArray(candidateVector)
        && candidateVector.length === queryVector.length
    )
        ? clamp(input.embedder.cosineSimilarity(queryVector, candidateVector))
        : 0;

    const lexicalTexts = input.lexicalTexts?.length ? input.lexicalTexts : [input.candidateText];
    const lexical = lexicalTexts.reduce((best, candidate) => Math.max(best, lexicalSimilarity(input.query, candidate)), 0);
    const keywordCoverage = lexicalTexts.reduce((best, candidate) => Math.max(best, keywordCoverageScore(input.query, candidate)), 0);
    const pathBoost = clamp(pathBoostScore(input.query, input.pathText), 0, 0.25);
    const lexicalComposite = Math.max(lexical, keywordCoverage);

    if (semantic <= 0) {
        return {
            semantic: 0,
            lexical,
            keywordCoverage,
            pathBoost,
            final: clamp(lexicalComposite * 0.85 + pathBoost),
            fallbackUsed: lexicalComposite > 0 || pathBoost > 0,
        };
    }

    return {
        semantic,
        lexical,
        keywordCoverage,
        pathBoost,
        final: clamp(
            semantic * weights.semantic
            + lexicalComposite * weights.lexical
            + pathBoost * weights.path,
        ),
        fallbackUsed: false,
    };
}

function lexicalSimilarity(query: string, candidate: string): number {
    const queryTokens = tokenizeSemanticText(query);
    const candidateTokens = tokenizeSemanticText(candidate);
    if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;
    const overlap = [...queryTokens].filter((token) => candidateTokens.has(token)).length;
    const union = new Set([...queryTokens, ...candidateTokens]).size;
    return union === 0 ? 0 : overlap / union;
}

function keywordCoverageScore(query: string, candidate: string): number {
    const keywords = extractSemanticKeywords(query);
    if (keywords.length === 0) return 0;
    const haystack = String(candidate || '').toLowerCase();
    const matched = keywords.filter((keyword) => haystack.includes(keyword)).length;
    return matched / keywords.length;
}

function pathBoostScore(query: string, pathText?: string): number {
    if (!pathText) return 0;
    const keywords = extractSemanticKeywords(query);
    const haystack = pathText.toLowerCase();
    let matched = 0;
    for (const keyword of keywords) {
        if (haystack.includes(keyword)) {
            matched += 1;
        }
    }
    return Math.min(0.25, matched * 0.05);
}

function clamp(value: number, min = 0, max = 1): number {
    return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
}
