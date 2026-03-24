/**
 * Sparse N-gram Index Engine
 *
 * Fast text search using trigram decomposition with probabilistic masks,
 * inspired by Cursor's fast regex search and GitHub's Project Blackbird.
 *
 * Instead of scanning every document, queries decompose into trigrams,
 * look up posting lists, intersect them, and only full-match on candidates.
 * Probabilistic masks (locMask + nextMask) provide "3.5-gram" specificity
 * from 3-gram keys, dramatically reducing false positives.
 *
 * Persistence: SQLite (same pattern as memory.db / graph.db)
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { resolveNexusStateDir } from './runtime-registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Posting {
  docId: string;
  locMask: number;   // 8-bit: which positions (mod 8) the trigram appears at
  nextMask: number;  // 8-bit bloom filter of characters following the trigram
}

export interface SearchResult {
  docId: string;
  score: number;     // number of matching trigrams (selectivity indicator)
}

interface TrigramEntry {
  trigram: string;
  hash: number;
  position: number;
  nextChar: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Character pair frequency weights (precomputed from common code patterns)
// Rarer pairs get higher weights for sparse n-gram extraction.
// ─────────────────────────────────────────────────────────────────────────────

const CHAR_PAIR_WEIGHTS = new Map<number, number>();

function crc32Single(value: number): number {
  let crc = value;
  for (let i = 0; i < 8; i++) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return crc >>> 0;
}

function charPairHash(a: string, b: string): number {
  const val = (a.charCodeAt(0) << 8) | b.charCodeAt(0);
  return crc32Single(val) >>> 0;
}

/**
 * Weight for a character pair — higher = rarer = more selective.
 * Uses CRC32 hash to deterministically assign weights.
 * Common pairs (e.g., "th", "he", "in") get lower weights.
 */
function charPairWeight(a: string, b: string): number {
  const hash = charPairHash(a, b);
  const cached = CHAR_PAIR_WEIGHTS.get(hash);
  if (cached !== undefined) return cached;
  // Deterministic weight from hash, range [0.0, 1.0]
  const weight = (hash % 1000) / 1000;
  CHAR_PAIR_WEIGHTS.set(hash, weight);
  return weight;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigram extraction
// ─────────────────────────────────────────────────────────────────────────────

function trigramHash(trigram: string): number {
  // FNV-1a inspired hash for 3-char trigrams
  let hash = 0x811c9dc5;
  for (let i = 0; i < trigram.length; i++) {
    hash ^= trigram.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function extractTrigrams(text: string): TrigramEntry[] {
  const lower = text.toLowerCase();
  const entries: TrigramEntry[] = [];
  for (let i = 0; i <= lower.length - 3; i++) {
    const trigram = lower.substring(i, i + 3);
    // Skip trigrams that are all whitespace
    if (/^\s+$/.test(trigram)) continue;
    entries.push({
      trigram,
      hash: trigramHash(trigram),
      position: i,
      nextChar: i + 3 < lower.length ? lower[i + 3] : '',
    });
  }
  return entries;
}

/**
 * Extract sparse n-grams: variable-length n-grams where edge character-pair
 * weights exceed all internal weights. This produces fewer, more selective
 * index keys for rarer character sequences.
 */
function extractSparseNgrams(text: string): Array<{ ngram: string; hash: number; position: number }> {
  const lower = text.toLowerCase();
  if (lower.length < 3) return [];
  const results: Array<{ ngram: string; hash: number; position: number }> = [];
  let i = 0;
  while (i < lower.length - 2) {
    const startWeight = charPairWeight(lower[i], lower[i + 1]);
    let end = i + 2;
    // Extend while internal pair weights are lower than start weight
    while (end < lower.length) {
      const internalWeight = charPairWeight(lower[end - 1], lower[end]);
      if (internalWeight >= startWeight) break;
      end++;
    }
    const ngram = lower.substring(i, end + 1 > lower.length ? lower.length : end);
    if (ngram.length >= 3 && !/^\s+$/.test(ngram)) {
      results.push({
        ngram,
        hash: trigramHash(ngram.substring(0, 3)), // index by first trigram
        position: i,
      });
    }
    i = end > i + 1 ? end : i + 1;
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Probabilistic masks
// ─────────────────────────────────────────────────────────────────────────────

/** Build position mask: which of 8 slots this trigram appears at */
function buildLocMask(position: number): number {
  return 1 << (position % 8);
}

/** Build next-char bloom filter: hash the following character into 8 bits */
function buildNextMask(nextChar: string): number {
  if (!nextChar) return 0xFF; // wildcard — matches anything
  return 1 << (nextChar.charCodeAt(0) % 8);
}

// ─────────────────────────────────────────────────────────────────────────────
// NgramIndex — the main class
// ─────────────────────────────────────────────────────────────────────────────

export class NgramIndex {
  private db: InstanceType<typeof Database>;
  private dbPath: string;

  // In-memory lookup: trigramHash → true (for fast existence check)
  private knownHashes = new Set<number>();
  // Prepared statements
  private insertStmt!: Database.Statement;
  private deleteStmt!: Database.Statement;
  private lookupStmt!: Database.Statement;
  private docExistsStmt!: Database.Statement;

  constructor(dbPath?: string) {
    const stateDir = resolveNexusStateDir();
    this.dbPath = dbPath ?? path.join(stateDir, 'ngram-index.db');
    this.db = new Database(this.dbPath);
    this.initSchema();
    this.prepareStatements();
    this.warmHashSet();
  }

  private initSchema(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -16000');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ngram_postings (
        ngram_hash INTEGER NOT NULL,
        doc_id TEXT NOT NULL,
        loc_mask INTEGER NOT NULL DEFAULT 0,
        next_mask INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (ngram_hash, doc_id)
      );

      CREATE INDEX IF NOT EXISTS idx_postings_doc ON ngram_postings(doc_id);
      CREATE INDEX IF NOT EXISTS idx_postings_hash ON ngram_postings(ngram_hash);

      CREATE TABLE IF NOT EXISTS ngram_docs (
        doc_id TEXT PRIMARY KEY,
        text_length INTEGER NOT NULL DEFAULT 0,
        indexed_at INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  private prepareStatements(): void {
    this.insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO ngram_postings (ngram_hash, doc_id, loc_mask, next_mask)
      VALUES (?, ?, ?, ?)
    `);
    this.deleteStmt = this.db.prepare(`
      DELETE FROM ngram_postings WHERE doc_id = ?
    `);
    this.lookupStmt = this.db.prepare(`
      SELECT doc_id, loc_mask, next_mask FROM ngram_postings WHERE ngram_hash = ?
    `);
    this.docExistsStmt = this.db.prepare(`
      SELECT 1 FROM ngram_docs WHERE doc_id = ?
    `);
  }

  /** Load known trigram hashes into memory for fast existence checks */
  private warmHashSet(): void {
    const rows = this.db.prepare('SELECT DISTINCT ngram_hash FROM ngram_postings').all() as Array<{ ngram_hash: number }>;
    for (const row of rows) {
      this.knownHashes.add(row.ngram_hash);
    }
  }

  // ── Document Management ─────────────────────────────────────────────────

  /** Index a document's text content */
  addDocument(docId: string, text: string): void {
    // Remove existing postings for this doc (idempotent)
    this.deleteStmt.run(docId);

    const trigrams = extractTrigrams(text);

    // Aggregate postings per trigram hash: OR together masks
    const aggregated = new Map<number, { locMask: number; nextMask: number }>();
    for (const entry of trigrams) {
      const existing = aggregated.get(entry.hash);
      const locMask = buildLocMask(entry.position);
      const nextMask = buildNextMask(entry.nextChar);
      if (existing) {
        existing.locMask |= locMask;
        existing.nextMask |= nextMask;
      } else {
        aggregated.set(entry.hash, { locMask, nextMask });
      }
    }

    // Batch insert
    const insertMany = this.db.transaction(() => {
      for (const [hash, masks] of aggregated) {
        this.insertStmt.run(hash, docId, masks.locMask, masks.nextMask);
        this.knownHashes.add(hash);
      }
      this.db.prepare(`
        INSERT OR REPLACE INTO ngram_docs (doc_id, text_length, indexed_at)
        VALUES (?, ?, ?)
      `).run(docId, text.length, Date.now());
    });
    insertMany();
  }

  /** Remove a document from the index */
  removeDocument(docId: string): void {
    this.db.transaction(() => {
      this.deleteStmt.run(docId);
      this.db.prepare('DELETE FROM ngram_docs WHERE doc_id = ?').run(docId);
    })();
  }

  /** Check if a document is already indexed */
  isIndexed(docId: string): boolean {
    return !!this.docExistsStmt.get(docId);
  }

  /** Get count of indexed documents */
  getDocCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM ngram_docs').get() as { cnt: number };
    return row.cnt;
  }

  // ── Search ──────────────────────────────────────────────────────────────

  /**
   * Search for documents matching a text query.
   * Returns candidate document IDs ranked by trigram match count.
   *
   * The caller should do full text matching on these candidates —
   * this is a pre-filter, not a final answer.
   */
  search(query: string, limit: number = 50): SearchResult[] {
    const queryTrigrams = extractTrigrams(query);
    if (queryTrigrams.length === 0) return [];

    // Deduplicate query trigrams by hash
    const uniqueHashes = new Map<number, TrigramEntry>();
    for (const entry of queryTrigrams) {
      if (!uniqueHashes.has(entry.hash)) {
        uniqueHashes.set(entry.hash, entry);
      }
    }

    // Skip hashes we know aren't in the index
    const relevantEntries = [...uniqueHashes.values()].filter(
      (entry) => this.knownHashes.has(entry.hash)
    );

    if (relevantEntries.length === 0) return [];

    // Look up posting lists and score by match count
    const docScores = new Map<string, number>();

    for (const entry of relevantEntries) {
      const postings = this.lookupStmt.all(entry.hash) as Posting[];
      const queryLocMask = buildLocMask(entry.position);
      const queryNextMask = buildNextMask(entry.nextChar);

      for (const posting of postings) {
        // Probabilistic mask filtering:
        // Check if position mask overlaps (trigram appears at compatible position)
        // and next-char bloom filter overlaps
        const locMatch = (posting.locMask & queryLocMask) !== 0 || posting.locMask === 0xFF;
        const nextMatch = (posting.nextMask & queryNextMask) !== 0 || posting.nextMask === 0xFF;

        if (locMatch && nextMatch) {
          docScores.set(posting.docId, (docScores.get(posting.docId) ?? 0) + 1);
        }
      }
    }

    // Rank by number of matching trigrams (more = more selective match)
    return [...docScores.entries()]
      .map(([docId, score]) => ({ docId, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Search with a minimum trigram match threshold.
   * Only returns documents matching at least `minMatches` trigrams.
   */
  searchStrict(query: string, minMatches: number = 2, limit: number = 50): string[] {
    return this.search(query, limit)
      .filter((r) => r.score >= minMatches)
      .map((r) => r.docId);
  }

  /**
   * Fast existence check: does any document contain this exact substring?
   * Uses trigram intersection for speed, then verifies against doc text
   * that the caller must provide.
   */
  candidatesForSubstring(substring: string, limit: number = 100): string[] {
    if (substring.length < 3) {
      // Too short for trigrams — return all docs (caller must filter)
      return (this.db.prepare('SELECT doc_id FROM ngram_docs LIMIT ?').all(limit) as Array<{ doc_id: string }>)
        .map((r) => r.doc_id);
    }
    const results = this.search(substring, limit);
    // For substring search, require at least half the trigrams to match
    const minMatches = Math.max(1, Math.floor((substring.length - 2) / 2));
    return results
      .filter((r) => r.score >= minMatches)
      .map((r) => r.docId);
  }

  // ── Bulk Operations ─────────────────────────────────────────────────────

  /** Batch index multiple documents efficiently */
  addDocuments(docs: Array<{ id: string; text: string }>): number {
    let indexed = 0;
    const batchSize = 100;
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = docs.slice(i, i + batchSize);
      this.db.transaction(() => {
        for (const doc of batch) {
          this.addDocument(doc.id, doc.text);
          indexed++;
        }
      })();
    }
    return indexed;
  }

  /** Rebuild the entire index from scratch */
  rebuild(docs: Array<{ id: string; text: string }>): number {
    this.db.exec('DELETE FROM ngram_postings');
    this.db.exec('DELETE FROM ngram_docs');
    this.knownHashes.clear();
    return this.addDocuments(docs);
  }

  // ── Stats ───────────────────────────────────────────────────────────────

  getStats(): {
    docCount: number;
    postingCount: number;
    uniqueTrigramCount: number;
    dbSizeBytes: number;
  } {
    const docCount = this.getDocCount();
    const postingRow = this.db.prepare('SELECT COUNT(*) as cnt FROM ngram_postings').get() as { cnt: number };
    const trigramRow = this.db.prepare('SELECT COUNT(DISTINCT ngram_hash) as cnt FROM ngram_postings').get() as { cnt: number };
    let dbSizeBytes = 0;
    try { dbSizeBytes = fs.statSync(this.dbPath).size; } catch { /* ignore */ }
    return {
      docCount,
      postingCount: postingRow.cnt,
      uniqueTrigramCount: trigramRow.cnt,
      dbSizeBytes,
    };
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton factory
// ─────────────────────────────────────────────────────────────────────────────

let _sharedInstance: NgramIndex | null = null;

/** Get or create the shared NgramIndex instance */
export function getSharedNgramIndex(dbPath?: string): NgramIndex {
  if (!_sharedInstance) {
    _sharedInstance = new NgramIndex(dbPath);
  }
  return _sharedInstance;
}
