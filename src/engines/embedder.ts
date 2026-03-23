/**
 * Embedder — TF-IDF local embeddings + optional API mode
 *
 * Mode 1 (default): Pure TF-IDF, no API needed. Works offline, fast.
 * Mode 2: OpenAI-compatible API (set NEXUS_EMBED_MODE=api, NEXUS_EMBED_URL, NEXUS_EMBED_KEY)
 * Mode 3: Ollama (set NEXUS_EMBED_MODE=ollama, NEXUS_OLLAMA_ENDPOINT, NEXUS_OLLAMA_MODEL)
 * Mode 4: HuggingFace (set NEXUS_EMBED_MODE=huggingface, NEXUS_HF_API_KEY, NEXUS_HF_MODEL)
 *
 * Output: fixed 128-dim float32 vectors (TF-IDF), 768-dim (Ollama), 384-dim (HF), or 1536-dim (API)
 */

import type Database from 'better-sqlite3';

// ─────────────────────────────────────────────────────────────────────────────
// TF-IDF Vocabulary (built from stored documents)
// ─────────────────────────────────────────────────────────────────────────────

const VECTOR_DIM = 128; // local TF-IDF dimension

export interface PersistentVocabularyStatus {
    docCount: number;
    termCount: number;
    reset: boolean;
    needsRecovery: boolean;
}

export function isSqliteCorruptionError(error: unknown): error is { code?: string; message?: string } {
    if (!error || typeof error !== 'object') return false;
    const code = 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
    const message = 'message' in error ? String((error as { message?: unknown }).message ?? '') : '';
    return code === 'SQLITE_CORRUPT' || /database disk image is malformed/i.test(message);
}

/** Stop words — excluded from TF-IDF vocabulary */
const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'can', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'and', 'or', 'but', 'if', 'then',
    'that', 'this', 'it', 'its', 'we', 'our', 'you', 'i', 'my', 'not',
    'no', 'so', 'up', 'out', 'about', 'just', 'into', 'over', 'after',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Hyperbolic Math (Poincare Ball Model)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poincare Ball model for hyperbolic space.
 * Hyperbolic distance is better suited for hierarchical structures (trees/code).
 */
export const HyperbolicMath = {
    /** 
     * Hyperbolic distance between two points in the unit ball.
     * d(u, v) = arcosh(1 + 2 * ||u-v||^2 / ( (1-||u||^2)(1-||v||^2) ))
     */
    dist(u: number[], v: number[]): number {
        const diffSq = u.reduce((sum, ui, i) => sum + Math.pow(ui - (v[i] || 0), 2), 0);
        const normU2 = u.reduce((sum, ui) => sum + ui * ui, 0);
        const normV2 = v.reduce((sum, vi) => sum + vi * vi, 0);

        const eps = 1e-9;
        const den = (1 - normU2) * (1 - normV2);
        if (Math.abs(den) < eps) return 100; // boundary

        const x = 1 + (2 * diffSq) / den;
        // arcosh(x) = ln(x + sqrt(x^2 - 1))
        return Math.log(x + Math.sqrt(x * x - 1));
    },

    /**
     * Mobius addition: u ⊕ v
     * Used to translate points in hyperbolic space while staying in the unit ball.
     */
    mobiusAdd(u: number[], v: number[]): never {
        void u;
        void v;
        throw new Error(
            'HyperbolicMath.mobiusAdd() is not implemented. ' +
            'Do not call this method until a full Möbius addition is written and tested.'
        );
    },

    /** Ensure vector is within unit ball (norm < 1) */
    project(v: number[]): number[] {
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
        const maxNorm = 0.999;
        if (norm <= maxNorm) return v;
        return v.map(x => (x / norm) * maxNorm);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Embedder
// ─────────────────────────────────────────────────────────────────────────────

export class Embedder {
    private vocabulary: Map<string, number> = new Map(); // word → index (0..127)
    private idf: Map<string, number> = new Map();        // word → IDF weight
    private docCount: number = 0;
    private vocabularyDb?: Database.Database;
    
    private embedMode: 'local' | 'api' | 'ollama' | 'huggingface';
    private apiUrl: string;
    private apiKey: string;
    private apiModel: string;
    private ollamaEndpoint: string;
    private ollamaModel: string;
    private hfEndpoint: string;
    private hfApiKey: string;
    private hfModel: string;

    constructor(vocabularyDb?: Database.Database) {
        this.embedMode = (process.env.NEXUS_EMBED_MODE as 'local' | 'api' | 'ollama' | 'huggingface') ?? 'local';
        this.vocabularyDb = vocabularyDb;
        
        // OpenAI API config
        this.apiUrl = process.env.NEXUS_EMBED_URL ?? 'https://api.openai.com/v1/embeddings';
        this.apiKey = process.env.NEXUS_EMBED_KEY ?? '';
        this.apiModel = process.env.NEXUS_EMBED_MODEL ?? 'text-embedding-3-small';
        
        // Ollama config
        this.ollamaEndpoint = process.env.NEXUS_OLLAMA_ENDPOINT ?? 'http://localhost:11434';
        this.ollamaModel = process.env.NEXUS_OLLAMA_MODEL ?? 'nomic-embed-text';
        
        // HuggingFace config
        this.hfEndpoint = 'https://api-inference.huggingface.co/pipeline/feature-extraction';
        this.hfApiKey = process.env.NEXUS_HF_API_KEY ?? '';
        this.hfModel = process.env.NEXUS_HF_MODEL ?? 'sentence-transformers/all-MiniLM-L6-v2';

        if (this.vocabularyDb) {
            this.initVocabularyTables();
        }
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /** Embed a string → float32 vector */
    async embed(text: string): Promise<number[]> {
        // Fallback chain: Ollama → HuggingFace → OpenAI API → Local TF-IDF
        if (this.embedMode === 'ollama' && this.ollamaEndpoint) {
            try {
                const vec = await this.ollamaEmbed(text);
                return HyperbolicMath.project(vec);
            } catch {
                // Fall through to next option
            }
        }
        
        if (this.embedMode === 'huggingface' && this.hfApiKey) {
            try {
                const vec = await this.huggingfaceEmbed(text);
                return HyperbolicMath.project(vec);
            } catch {
                // Fall through to next option
            }
        }
        
        if (this.embedMode === 'api' && this.apiKey) {
            try {
                const vec = await this.apiEmbed(text);
                return HyperbolicMath.project(vec);
            } catch {
                // Fall through to local
            }
        }
        
        return this.localEmbed(text);
    }

    /** 
     * Generate a hierarchical embedding.
     * Shifts the vector "deeper" into the Poincare ball relative to a parent.
     */
    embedHierarchical(text: string, parentVector?: number[], depth: number = 0): number[] {
        const base = this.localEmbed(text);
        if (!parentVector || depth === 0) return base;

        // Hierarchical shift: move towards the boundary (norm -> 1) 
        // while staying in the "shadow" of the parent
        const alpha = 0.3; // alignment with parent
        const shift = 0.2; // depth push

        const blended = base.map((x, i) => (1 - alpha) * x + alpha * parentVector[i]);
        const norm = Math.sqrt(blended.reduce((s, x) => s + x * x, 0));

        // Push towards boundary: new_norm = old_norm + (1 - old_norm) * shift
        const targetNorm = norm + (1 - norm) * (shift * Math.min(depth, 5));
        const scaled = blended.map(x => (x / (norm || 1)) * targetNorm);

        return HyperbolicMath.project(scaled);
    }

    /** Update vocabulary with new documents (call as you store memories) */
    fitVocabulary(docs: string[]): PersistentVocabularyStatus {
        if (docs.length === 0) return this.currentPersistentVocabularyStatus();
        if (this.vocabularyDb) {
            const initStatus = this.initVocabularyTables();
            if (initStatus.needsRecovery) return initStatus;
            const updateStatus = this.upsertPersistentVocabularyStats(docs);
            if (updateStatus.needsRecovery) return updateStatus;
            return this.rebuildPersistentVocabulary();
        }

        // Count document frequency for each term
        const dfCount: Map<string, number> = new Map();

        for (const doc of docs) {
            const terms = new Set(this.tokenize(doc));
            for (const term of terms) {
                dfCount.set(term, (dfCount.get(term) ?? 0) + 1);
            }
            this.docCount++;
        }

        // Assign vocab indices (top 128 by df)
        const sorted = [...dfCount.entries()].sort((a, b) => b[1] - a[1]);
        this.vocabulary.clear();
        this.idf.clear();

        for (const [term, df] of sorted.slice(0, VECTOR_DIM)) {
            const idx = this.vocabulary.size;
            this.vocabulary.set(term, idx);
            // IDF = log((N + 1) / (df + 1)) + 1  (smoothed)
            this.idf.set(term, Math.log((this.docCount + 1) / (df + 1)) + 1);
        }
        return this.currentPersistentVocabularyStatus();
    }

    public rebuildPersistentVocabulary(): PersistentVocabularyStatus {
        if (!this.vocabularyDb) return this.currentPersistentVocabularyStatus();
        const initStatus = this.initVocabularyTables();
        if (initStatus.needsRecovery) return initStatus;
        try {
            const docCountRow = this.vocabularyDb.prepare(
                `SELECT value FROM vocabulary_meta WHERE key = 'doc_count'`
            ).get() as { value?: string } | undefined;
            const docCount = Number.parseInt(docCountRow?.value ?? '0', 10);
            this.docCount = Number.isFinite(docCount) ? docCount : 0;

            const rows = this.vocabularyDb.prepare(
                `SELECT term, df FROM vocabulary_stats ORDER BY df DESC, term ASC LIMIT ?`
            ).all(VECTOR_DIM) as Array<{ term: string; df: number }>;

            this.vocabulary.clear();
            this.idf.clear();
            for (const { term, df } of rows) {
                const idx = this.vocabulary.size;
                this.vocabulary.set(term, idx);
                this.idf.set(term, Math.log((this.docCount + 1) / (df + 1)) + 1);
            }
            return this.currentPersistentVocabularyStatus();
        } catch (error) {
            return this.handlePersistentVocabularyFailure(error);
        }
    }

    /** Dimension of vectors produced by this embedder */
    get dimensions(): number {
        switch (this.embedMode) {
            case 'ollama': return 768; // nomic-embed-text produces 768-dim
            case 'huggingface': return 384; // MiniLM-L6-v2 produces 384-dim
            case 'api': return 1536; // OpenAI default
            default: return VECTOR_DIM; // 128 for TF-IDF
        }
    }

    // ── Local TF-IDF embed ───────────────────────────────────────────────────

    localEmbed(text: string): number[] {
        const tokens = this.tokenize(text);
        const tf: Map<string, number> = new Map();

        for (const t of tokens) {
            tf.set(t, (tf.get(t) ?? 0) + 1);
        }

        const vector = new Array<number>(VECTOR_DIM).fill(0);

        for (const [term, count] of tf) {
            const idx = this.vocabulary.get(term);
            if (idx !== undefined) {
                const idf = this.idf.get(term) ?? 1;
                vector[idx] = (count / tokens.length) * idf; // TF × IDF
            } else {
                // Hash fallback for OOV terms
                const h = this.hashCode(term) % VECTOR_DIM;
                vector[Math.abs(h)] += 0.1;
            }
        }

        return this.normalize(vector);
    }

    // ── API embed (OpenAI-compatible) ────────────────────────────────────────

    async apiEmbed(text: string): Promise<number[]> {
        const response = await fetch(this.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.apiModel,
                input: text.slice(0, 8000), // truncate to API limit
            }),
        });

        if (!response.ok) {
            throw new Error(`Embed API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as { data: [{ embedding: number[] }] };
        return data.data[0].embedding;
    }

    // ── Ollama embed ───────────────────────────────────────────────────────────

    async ollamaEmbed(text: string): Promise<number[]> {
        const response = await fetch(`${this.ollamaEndpoint}/api/embeddings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: this.ollamaModel,
                prompt: text.slice(0, 8000),
            }),
        });

        if (!response.ok) {
            throw new Error(`Ollama embed error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as { embedding: number[] };
        return data.embedding;
    }

    // ── HuggingFace embed ─────────────────────────────────────────────────────

    async huggingfaceEmbed(text: string): Promise<number[]> {
        const response = await fetch(`${this.hfEndpoint}/${this.hfModel}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.hfApiKey}`,
            },
            body: JSON.stringify({
                inputs: text.slice(0, 8000),
            }),
        });

        if (!response.ok) {
            throw new Error(`HuggingFace embed error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as number[];
        return data;
    }

    // ── Cosine similarity ────────────────────────────────────────────────────

    cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length) return 0;
        let dot = 0, magA = 0, magB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            magA += a[i] * a[i];
            magB += b[i] * b[i];
        }
        const denom = Math.sqrt(magA) * Math.sqrt(magB);
        return denom === 0 ? 0 : dot / denom;
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private tokenize(text: string): string[] {
        return text
            .toLowerCase()
            .replace(/[^a-z0-9\s_/-]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2 && !STOP_WORDS.has(w));
    }

    private normalize(v: number[]): number[] {
        const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
        if (mag === 0) return v;
        return v.map(x => x / mag);
    }

    private hashCode(s: string): number {
        let h = 0;
        for (let i = 0; i < s.length; i++) {
            h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
        }
        return h;
    }

    private initVocabularyTables(): PersistentVocabularyStatus {
        if (!this.vocabularyDb) return this.currentPersistentVocabularyStatus();
        try {
            this.vocabularyDb.exec(`
                CREATE TABLE IF NOT EXISTS vocabulary_stats (
                    term TEXT PRIMARY KEY,
                    df INTEGER NOT NULL DEFAULT 1,
                    last_seen INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS vocabulary_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                INSERT OR IGNORE INTO vocabulary_meta(key, value) VALUES('doc_count', '0');
            `);
            return this.currentPersistentVocabularyStatus();
        } catch (error) {
            return this.handlePersistentVocabularyFailure(error);
        }
    }

    private upsertPersistentVocabularyStats(docs: string[]): PersistentVocabularyStatus {
        if (!this.vocabularyDb) return this.currentPersistentVocabularyStatus();
        const dfCount = new Map<string, number>();

        for (const doc of docs) {
            const terms = new Set(this.tokenize(doc));
            for (const term of terms) {
                dfCount.set(term, (dfCount.get(term) ?? 0) + 1);
            }
        }

        try {
            const upsert = this.vocabularyDb.prepare(`
                INSERT INTO vocabulary_stats(term, df, last_seen) VALUES(?, ?, ?)
                ON CONFLICT(term) DO UPDATE SET
                    df = df + excluded.df,
                    last_seen = excluded.last_seen
            `);
            const updateDocCount = this.vocabularyDb.prepare(`
                UPDATE vocabulary_meta
                SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)
                WHERE key = 'doc_count'
            `);
            const txn = this.vocabularyDb.transaction((entries: Array<[string, number]>, batchSize: number) => {
                const now = Date.now();
                for (const [term, df] of entries) {
                    upsert.run(term, df, now);
                }
                updateDocCount.run(batchSize);
            });
            txn([...dfCount.entries()], docs.length);
            return this.currentPersistentVocabularyStatus();
        } catch (error) {
            return this.handlePersistentVocabularyFailure(error);
        }
    }

    private clearPersistentVocabulary(): void {
        this.vocabulary.clear();
        this.idf.clear();
        this.docCount = 0;
    }

    private currentPersistentVocabularyStatus(reset: boolean = false, needsRecovery: boolean = false): PersistentVocabularyStatus {
        return {
            docCount: this.docCount,
            termCount: this.vocabulary.size,
            reset,
            needsRecovery,
        };
    }

    private handlePersistentVocabularyFailure(error: unknown): PersistentVocabularyStatus {
        if (!isSqliteCorruptionError(error)) {
            throw error;
        }
        this.clearPersistentVocabulary();
        return this.currentPersistentVocabularyStatus(true, true);
    }
}

export const createEmbedder = () => new Embedder();
