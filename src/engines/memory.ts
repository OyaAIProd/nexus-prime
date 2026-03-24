/**
 * Memory Engine — Persistent Zettelkasten
 *
 * Three-tier memory system backed by SQLite for cross-session persistence.
 * Memories link to each other (Zettelkasten) — recall returns context networks,
 * not just isolated facts. High-value memories trigger fission (broadcast).
 *
 * Persistence: ~/.nexus-prime/memory.db
 * Load on MCP start. Flush on exit.
 */

import Database from 'better-sqlite3';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID, createHash } from 'crypto';
import { execSync } from 'child_process';
import {
  Embedder,
  HyperbolicMath,
  isSqliteCorruptionError,
  type PersistentVocabularyStatus,
} from './embedder.js';
import { GraphMemoryEngine } from './graph-memory.js';
import { NgramIndex } from './ngram-index.js';
import { podNetwork } from './pod-network.js';
import { nexusEventBus } from './event-bus.js';
import { SECRET_PATTERNS } from './security-shield.js';
import { resolveNexusStateDir } from './runtime-registry.js';
import {
  createEmptyReconciliationSummary,
  createMemoryProvenance,
  deriveCandidateFacts,
  type MemoryCandidateFact,
  type MemoryMaintenanceResult,
  type MemoryProvenance,
  type MemoryReconciliationAction,
  type MemoryReconciliationEntry,
  type MemoryReconciliationSummary,
} from './memory-control-plane.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let _cachedRepoId: string | undefined;

/** Derive a stable repoId from git remote URL or workspace path */
function resolveCurrentRepoId(): string {
  if (_cachedRepoId) return _cachedRepoId;
  try {
    const remote = execSync('git config --get remote.origin.url', { timeout: 2000, encoding: 'utf8' }).trim();
    if (remote) {
      _cachedRepoId = createHash('sha256').update(remote).digest('hex').slice(0, 12);
      return _cachedRepoId;
    }
  } catch { /* not a git repo or no remote */ }
  _cachedRepoId = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12);
  return _cachedRepoId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MemoryItem {
  id: string;
  content: string;
  priority: number;
  timestamp: number;
  tags: string[];
  tier: 'prefrontal' | 'hippocampus' | 'cortex';
  scope: 'session' | 'project' | 'user' | 'promoted' | 'shared';
  state: 'active' | 'quarantined' | 'scrap' | 'expired';
  source: 'operator' | 'runtime' | 'worker' | 'imported' | 'system';
  sessionId?: string;
  accessCount: number;
  links?: string[];  // IDs of related memories (Zettelkasten links)
  parentId?: string;
  depth?: number;
  entropy: number; // 0.0 (fresh) to 1.0 (dead/noise)
  mass: number;    // Weight of importance (gravity)
  trust: number;
  qmdRecency?: number;
  qmdFrequency?: number;
  qmdRelevance?: number;
  expiresAt?: number;
  supersedes?: string;
  supersededBy?: string;
  provenance: MemoryProvenance;
}

export interface MemoryLink {
  fromId: string;
  toId: string;
  weight: number; // 0-1, decays if unused
  type: 'semantic' | 'temporal' | 'tagged';
}

export interface MemoryStats {
  prefrontal: number;
  hippocampus: number;
  cortex: number;
  totalLinks: number;
  oldestEntry: number | null;
  topTags: string[];
}

export interface MemoryStorageStatus {
  requestedDbPath: string;
  activeDbPath: string;
  stateRoot: string;
  graphDbPath: string;
  vaultDir: string;
  fallbackApplied: boolean;
  fallbackReason?: string;
}

export type MemoryContainerLane = 'profile' | 'workspace' | 'shared' | 'inbox';

export interface MemoryRecallFilters {
  sessionId?: string;
  repoId?: string;
  workspaceId?: string;
  projectId?: string;
  lane?: MemoryContainerLane;
  includeShared?: boolean;
  includeProfile?: boolean;
  includeHidden?: boolean;
}

export interface MemoryContainerSummary {
  generatedAt: number;
  byLane: Record<MemoryContainerLane, number>;
  byRepoId: Record<string, number>;
  byProjectId: Record<string, number>;
  byWorkspaceId: Record<string, number>;
  hiddenCount: number;
}

export interface MemoryBackupSnapshot {
  timestamp: number;
  reason: string;
  path: string;
  itemCount: number;
}

export interface MemoryEntityReference {
  type: 'session' | 'run' | 'skill' | 'workflow';
  id: string;
}

export interface MemorySnapshot {
  id: string;
  tier: MemoryItem['tier'];
  scope: MemoryItem['scope'];
  state: MemoryItem['state'];
  source: MemoryItem['source'];
  priority: number;
  timestamp: number;
  tags: string[];
  excerpt: string;
  parentId?: string;
  depth?: number;
  accessCount: number;
  linkCount: number;
  sessionId?: string;
  relevanceScore: number;
  importanceScore: number;
  freshnessScore: number;
  trustScore: number;
  entropyScore: number;
  provenance: MemoryProvenance;
  expiresAt?: number;
  supersedes?: string;
  supersededBy?: string;
  related: MemoryEntityReference[];
}

export interface MemoryDetail extends MemorySnapshot {
  content: string;
  lineage: MemorySnapshot[];
  linkedMemories: MemorySnapshot[];
  timeline: MemorySnapshot[];
}

export interface MemoryTraceDetail extends MemoryDetail {
  reconciliation?: MemoryReconciliationEntry;
}

export interface MemoryNetworkNode {
  id: string;
  label: string;
  entityType: 'memory' | 'session' | 'run' | 'skill' | 'workflow';
  tier?: MemoryItem['tier'];
  priority?: number;
  timestamp?: number;
}

export interface MemoryNetworkLink {
  source: string;
  target: string;
  type: 'semantic' | 'temporal' | 'tagged' | 'lineage' | 'artifact-derived';
  weight: number;
}

export interface MemoryNetworkSnapshot {
  focusId?: string;
  nodes: MemoryNetworkNode[];
  links: MemoryNetworkLink[];
}

export interface MemoryCheckFinding {
  id: string;
  severity: 'low' | 'medium' | 'high';
  category: 'duplicate' | 'contradiction' | 'secret' | 'claim' | 'entropy' | 'provenance';
  message: string;
  relatedIds: string[];
}

export interface MemoryCheckResult {
  contentPreview: string;
  action: 'allow' | 'warn' | 'quarantine' | 'block';
  findings: MemoryCheckFinding[];
  duplicateCluster: string[];
  canPromote: boolean;
}

export interface MemoryConfig {
  decayRate?: number;
  priorityRetention?: number;
  flushEntropyThreshold?: number;
  recallCandidateLimit?: number;
}

export interface MemoryAuditResult {
  scanned: number;
  quarantined: MemorySnapshot[];
  findings: Array<MemoryCheckResult & { id: string }>;
}

export interface MemoryHealthSummary {
  generatedAt: number;
  total: number;
  active: number;
  quarantined: number;
  scrap: number;
  expired: number;
  promoted: number;
  shared: number;
  topTags: string[];
}

export interface MemoryExportItem {
  id: string;
  content: string;
  priority: number;
  timestamp: number;
  tags: string[];
  tier: MemoryItem['tier'];
  scope: MemoryItem['scope'];
  state: MemoryItem['state'];
  source: MemoryItem['source'];
  sessionId?: string;
  accessCount: number;
  parentId?: string;
  depth?: number;
  entropy: number;
  mass: number;
  trust: number;
  expiresAt?: number;
  supersedes?: string;
  supersededBy?: string;
  provenance: MemoryProvenance;
}

export interface MemoryExportBundle {
  version: number;
  exportedAt: number;
  sessionId: string;
  stats: MemoryStats;
  health: MemoryHealthSummary;
  items: MemoryExportItem[];
}

export interface TokenTelemetryEntry {
  id: string;
  sessionId: string;
  timestamp: number;
  task: string;
  model: string;
  tokensOptimized: number;
  tokensSaved: number;
  tokensForwarded: number;
  compressionRatio: number;
  fileCount: number;
  usdValueSaved: number;
}

interface MemoryRow {
  id: string;
  content: string;
  priority: number;
  timestamp: number;
  tags: string;
  tier: MemoryItem['tier'];
  scope?: MemoryItem['scope'];
  state?: MemoryItem['state'];
  source?: MemoryItem['source'];
  session_id?: string;
  access_count: number;
  parent_id?: string;
  depth?: number;
  entropy?: number;
  mass?: number;
  trust?: number;
  qmd_recency?: number | null;
  qmd_frequency?: number | null;
  qmd_relevance?: number | null;
  provenance_json?: string;
  expires_at?: number | null;
  supersedes?: string | null;
  superseded_by?: string | null;
}

interface MemoryLinkRow {
  from_id: string;
  to_id: string;
  weight: number;
  type: string;
}

interface TokenLedgerRow {
  id: string;
  session_id: string;
  timestamp: number;
  task: string;
  model: string;
  tokens_optimized: number;
  tokens_saved: number;
  tokens_forwarded: number;
  compression_ratio: number;
  file_count: number;
  usd_value_saved: number;
}

interface MemoryDbSnapshot {
  memories: MemoryRow[];
  memoryLinks: MemoryLinkRow[];
  tokenLedger: TokenLedgerRow[];
}

function resolvePreferredStateRoot(): string {
  return process.env.NEXUS_STATE_DIR?.trim() || resolveNexusStateDir();
}

function isWritableStorageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return ['readonly', 'EACCES', 'EROFS', 'ENOENT', 'permission denied', 'SQLITE_CANTOPEN']
    .some((fragment) => message.includes(fragment));
}

function ensureWritableDirectory(target: string): void {
  fs.mkdirSync(target, { recursive: true });
  fs.accessSync(target, fs.constants.W_OK);
}

function resolveFallbackStateRoot(preferredStateRoot: string): string {
  const candidates = [
    preferredStateRoot,
    process.env.NEXUS_STATE_DIR?.trim(),
    path.join(os.tmpdir(), 'nexus-prime-state'),
    path.join(process.cwd(), '.nexus-prime-state'),
  ].filter((entry): entry is string => Boolean(entry));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    try {
      ensureWritableDirectory(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`No writable Nexus state root available outside ${preferredStateRoot}`);
}

function openMemoryDatabase(requestedDbPath: string): {
  db: Database.Database;
  dbPath: string;
  stateRoot: string;
  fallbackApplied: boolean;
  fallbackReason?: string;
} {
  const preferredStateRoot = resolvePreferredStateRoot();
  const requestedDbRoot = path.dirname(requestedDbPath);
  try {
    ensureWritableDirectory(preferredStateRoot);
    ensureWritableDirectory(requestedDbRoot);
    return {
      db: new Database(requestedDbPath),
      dbPath: requestedDbPath,
      stateRoot: preferredStateRoot,
      fallbackApplied: false,
    };
  } catch (error) {
    if (!isWritableStorageError(error)) {
      throw error;
    }

    const fallbackReason = error instanceof Error ? error.message : String(error || 'unwritable database path');
    const fallbackStateRoot = resolveFallbackStateRoot(preferredStateRoot);
    const fallbackDbPath = path.join(fallbackStateRoot, path.basename(requestedDbPath) || 'memory.db');
    ensureWritableDirectory(fallbackStateRoot);
    console.error(`[MemoryEngine] Falling back from ${requestedDbPath} to ${fallbackDbPath}: ${fallbackReason}`);
    return {
      db: new Database(fallbackDbPath),
      dbPath: fallbackDbPath,
      stateRoot: fallbackStateRoot,
      fallbackApplied: true,
      fallbackReason,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MemoryEngine
// ─────────────────────────────────────────────────────────────────────────────

export class MemoryEngine {
  public db: Database.Database;
  private dbPath: string;
  private requestedDbPath: string;
  private stateRoot: string;
  private graphDbPath: string;
  private storageFallbackApplied = false;
  private storageFallbackReason?: string;
  private graphMirror?: GraphMemoryEngine;
  private ngramIndex?: NgramIndex;
  private sessionId: string;
  private vaultDir: string;
  private vaultItemsDir: string;
  private vaultExportsDir: string;
  private vaultNotesDir: string;
  private vaultEntityNotesDir: string;
  private vaultRunNotesDir: string;
  private vaultSessionNotesDir: string;
  private backupMetadataPath: string;
  private lastReconciliationSummary: MemoryReconciliationSummary = createEmptyReconciliationSummary();
  private lastPreCompactionBackup: MemoryBackupSnapshot | null = null;

  private config: Required<MemoryConfig>;
  private incrementAccessStmt!: Database.Statement;
  private incrementAccessTxn!: (ids: string[]) => void;
  private vaultDirty = new Set<string>();
  private vaultFlushTimer?: NodeJS.Timeout;
  private vaultNeedsFullSync = false;

  // In-RAM working tiers (flushed to DB periodically)
  private prefrontal: MemoryItem[] = [];
  private maxPrefrontal = 7;
  private maxHippocampus = 200;

  // Vector index (in-memory TF-IDF) — rebuilt on load
  private embedder: Embedder;
  // Maps vector item id → memory id
  private vectorIdToMemoryId: Map<number, string> = new Map();
  private memoryIdToVectorId: Map<string, number> = new Map();
  private nextVectorId = 1;

  constructor(dbPath?: string, config?: MemoryConfig) {
    this.config = {
      decayRate: config?.decayRate ?? 0.05,
      priorityRetention: config?.priorityRetention ?? 0.95,
      flushEntropyThreshold: config?.flushEntropyThreshold ?? 0.9,
      recallCandidateLimit: Math.max(config?.recallCandidateLimit ?? 200, 1),
    };
    
    const requestedDbPath = dbPath ?? path.join(resolvePreferredStateRoot(), 'memory.db');
    const opened = openMemoryDatabase(requestedDbPath);
    this.requestedDbPath = requestedDbPath;
    this.dbPath = opened.dbPath;
    this.stateRoot = opened.stateRoot;
    this.graphDbPath = path.join(path.dirname(this.dbPath), 'graph.db');
    this.storageFallbackApplied = opened.fallbackApplied;
    this.storageFallbackReason = opened.fallbackReason;
    this.db = opened.db;
    try {
      this.graphMirror = new GraphMemoryEngine(this.graphDbPath);
    } catch {
      this.graphMirror = undefined;
    }
    try {
      this.ngramIndex = new NgramIndex(path.join(path.dirname(this.dbPath), 'ngram-index.db'));
    } catch {
      this.ngramIndex = undefined;
    }
    this.sessionId = randomUUID();
    this.vaultDir = path.join(this.stateRoot, 'memory-vault');
    this.vaultItemsDir = path.join(this.vaultDir, 'items');
    this.vaultExportsDir = path.join(this.vaultDir, 'exports');
    this.vaultNotesDir = path.join(this.vaultDir, 'notes');
    this.vaultEntityNotesDir = path.join(this.vaultNotesDir, 'entities');
    this.vaultRunNotesDir = path.join(this.vaultNotesDir, 'runs');
    this.vaultSessionNotesDir = path.join(this.vaultNotesDir, 'sessions');
    this.backupMetadataPath = path.join(this.vaultExportsDir, 'last-pre-compaction-backup.json');
    fs.mkdirSync(this.vaultItemsDir, { recursive: true });
    fs.mkdirSync(this.vaultExportsDir, { recursive: true });
    fs.mkdirSync(path.join(this.vaultNotesDir, 'memories'), { recursive: true });
    fs.mkdirSync(this.vaultEntityNotesDir, { recursive: true });
    fs.mkdirSync(this.vaultRunNotesDir, { recursive: true });
    fs.mkdirSync(this.vaultSessionNotesDir, { recursive: true });

    this.initSchema();
    this.embedder = new Embedder(this.db);
    this.prepareStatements();
    this.load();
    this.loadBackupMetadata();
  }

  getNgramIndex(): NgramIndex | undefined {
    return this.ngramIndex;
  }

  getStorageStatus(): MemoryStorageStatus {
    return {
      requestedDbPath: this.requestedDbPath,
      activeDbPath: this.dbPath,
      stateRoot: this.stateRoot,
      graphDbPath: this.graphDbPath,
      vaultDir: this.vaultDir,
      fallbackApplied: this.storageFallbackApplied,
      fallbackReason: this.storageFallbackReason,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Schema
  // ─────────────────────────────────────────────────────────────────────────

  private initSchema(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -32000');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('temp_store = MEMORY');

    this.runMigrations();
  }

  private prepareStatements(): void {
    this.incrementAccessStmt = this.db.prepare(
      'UPDATE memories SET access_count = access_count + 1 WHERE id = ?'
    );
    this.incrementAccessTxn = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        this.incrementAccessStmt.run(id);
      }
    });
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        description TEXT
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id          TEXT PRIMARY KEY,
        content     TEXT NOT NULL,
        priority    REAL NOT NULL DEFAULT 1.0,
        timestamp   INTEGER NOT NULL,
        tags        TEXT NOT NULL DEFAULT '[]',
        tier        TEXT NOT NULL DEFAULT 'hippocampus',
        scope       TEXT NOT NULL DEFAULT 'session',
        state       TEXT NOT NULL DEFAULT 'active',
        source      TEXT NOT NULL DEFAULT 'runtime',
        session_id  TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        parent_id   TEXT,
        depth       INTEGER DEFAULT 0,
        entropy     REAL NOT NULL DEFAULT 0.0,
        mass        REAL NOT NULL DEFAULT 1.0,
        trust       REAL NOT NULL DEFAULT 0.6,
        qmd_recency REAL DEFAULT NULL,
        qmd_frequency REAL DEFAULT NULL,
        qmd_relevance REAL DEFAULT NULL,
        provenance_json TEXT NOT NULL DEFAULT '{}',
        expires_at  INTEGER,
        supersedes  TEXT,
        superseded_by TEXT
      );
    `);

    // Migration logic for existing tables
    const tableInfo = this.db.prepare("PRAGMA table_info(memories)").all() as any[];
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('parent_id')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN parent_id TEXT");
    }
    if (!columns.includes('depth')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN depth INTEGER DEFAULT 0");
    }
    if (!columns.includes('entropy')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN entropy REAL NOT NULL DEFAULT 0.0");
    }
    if (!columns.includes('mass')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN mass REAL NOT NULL DEFAULT 1.0");
    }
    if (!columns.includes('scope')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'session'");
    }
    if (!columns.includes('state')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN state TEXT NOT NULL DEFAULT 'active'");
    }
    if (!columns.includes('source')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'runtime'");
    }
    if (!columns.includes('trust')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN trust REAL NOT NULL DEFAULT 0.6");
    }
    if (!columns.includes('qmd_recency')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN qmd_recency REAL DEFAULT NULL');
    }
    if (!columns.includes('qmd_frequency')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN qmd_frequency REAL DEFAULT NULL');
    }
    if (!columns.includes('qmd_relevance')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN qmd_relevance REAL DEFAULT NULL');
    }
    if (!columns.includes('provenance_json')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!columns.includes('expires_at')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN expires_at INTEGER");
    }
    if (!columns.includes('supersedes')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN supersedes TEXT");
    }
    if (!columns.includes('superseded_by')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN superseded_by TEXT");
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_links(
      from_id  TEXT NOT NULL,
      to_id    TEXT NOT NULL,
      weight   REAL NOT NULL DEFAULT 0.5,
      type     TEXT NOT NULL DEFAULT 'semantic',
      PRIMARY KEY(from_id, to_id),
      FOREIGN KEY(from_id) REFERENCES memories(id) ON DELETE CASCADE,
      FOREIGN KEY(to_id)   REFERENCES memories(id) ON DELETE CASCADE
    );

      CREATE INDEX IF NOT EXISTS idx_memories_tier      ON memories(tier);
      CREATE INDEX IF NOT EXISTS idx_memories_priority  ON memories(priority DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_state_scope ON memories(state, scope);
      CREATE INDEX IF NOT EXISTS idx_memories_state_expiry ON memories(state, expires_at);
      CREATE INDEX IF NOT EXISTS idx_memories_session_state ON memories(session_id, state);
      CREATE INDEX IF NOT EXISTS idx_links_from         ON memory_links(from_id);

      CREATE TABLE IF NOT EXISTS token_ledger(
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        task TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens_optimized INTEGER NOT NULL,
        tokens_saved INTEGER NOT NULL,
        tokens_forwarded INTEGER NOT NULL,
        compression_ratio REAL NOT NULL,
        file_count INTEGER NOT NULL,
        usd_value_saved REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_token_ledger_session ON token_ledger(session_id);
      CREATE INDEX IF NOT EXISTS idx_token_ledger_timestamp ON token_ledger(timestamp DESC);

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

    const currentVersion = (
      this.db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v?: number } | undefined
    )?.v ?? 0;
    if (currentVersion < 1) {
      this.db.prepare(
        'INSERT OR IGNORE INTO schema_version(version, applied_at, description) VALUES (?, ?, ?)'
      ).run(1, Date.now(), 'baseline');
    }
    if (currentVersion < 2) {
      this.db.prepare(
        'INSERT OR IGNORE INTO schema_version(version, applied_at, description) VALUES (?, ?, ?)'
      ).run(2, Date.now(), 'qmd-columns');
    }
    if (currentVersion < 3) {
      this.db.prepare(
        'INSERT OR IGNORE INTO schema_version(version, applied_at, description) VALUES (?, ?, ?)'
      ).run(3, Date.now(), 'vocabulary-stats');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Persistence
  // ─────────────────────────────────────────────────────────────────────────

  /** Record token telemetry to local sqlite ledger */
  insertTokenTelemetry(entry: Omit<TokenTelemetryEntry, 'id' | 'timestamp'>): void {
    try {
      this.db.prepare(`
        INSERT INTO token_ledger (
          id, session_id, timestamp, task, model,
          tokens_optimized, tokens_saved, tokens_forwarded,
          compression_ratio, file_count, usd_value_saved
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), entry.sessionId, Date.now(), entry.task, entry.model,
        entry.tokensOptimized, entry.tokensSaved, entry.tokensForwarded,
        entry.compressionRatio, entry.fileCount, entry.usdValueSaved
      );
    } catch (e) {
      console.error('Failed to insert token telemetry:', e);
    }
  }

  /** Restore hippocampus + cortex from DB on startup */
  load(): void {
    let rows: MemoryRow[];
    try {
      rows = this.db.prepare(
        `SELECT * FROM memories ORDER BY priority DESC, timestamp DESC LIMIT 500`
      ).all() as MemoryRow[];
    } catch (error) {
      throw this.createMemoryDbLoadError(error);
    }

    this.ensurePersistentVocabulary(rows);

    for (const row of rows) {
      const item: MemoryItem = {
        id: row.id,
        content: row.content,
        priority: row.priority,
        timestamp: row.timestamp,
        tags: JSON.parse(row.tags as string),
        tier: row.tier as MemoryItem['tier'],
        scope: (row.scope ?? 'session') as MemoryItem['scope'],
        state: (row.state ?? 'active') as MemoryItem['state'],
        source: (row.source ?? 'runtime') as MemoryItem['source'],
        sessionId: row.session_id,
        accessCount: row.access_count,
        entropy: row.entropy ?? 0,
        mass: row.mass ?? 1.0,
        trust: row.trust ?? 0.6,
        expiresAt: row.expires_at ?? undefined,
        supersedes: row.supersedes ?? undefined,
        supersededBy: row.superseded_by ?? undefined,
        provenance: this.parseProvenance(row.provenance_json, row.source ?? 'runtime', row.session_id, row.tags),
      };

      // Restore prefrontal items to RAM
      if (item.tier === 'prefrontal') {
        this.prefrontal.push(item);
      }

      // Rebuild in-memory vector index (synchronously via local embed)
      this.indexMemory(item.id, item.content);
    }

    this.primeGraphMirror(rows);
    this.syncVault(true);
    this.checkGraphCoverage();

    // Backfill n-gram index for memories not yet indexed
    if (this.ngramIndex) {
      try {
        const unindexed = rows.filter((row) => !this.ngramIndex!.isIndexed(row.id));
        if (unindexed.length > 0) {
          this.ngramIndex.addDocuments(unindexed.map((row) => ({ id: row.id, text: row.content })));
        }
      } catch { /* best-effort backfill */ }
    }
  }

  private loadBackupMetadata(): void {
    try {
      if (!fs.existsSync(this.backupMetadataPath)) {
        this.lastPreCompactionBackup = null;
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(this.backupMetadataPath, 'utf8'));
      if (parsed && typeof parsed.path === 'string' && typeof parsed.reason === 'string' && typeof parsed.timestamp === 'number') {
        this.lastPreCompactionBackup = {
          path: parsed.path,
          reason: parsed.reason,
          timestamp: parsed.timestamp,
          itemCount: Number(parsed.itemCount || 0),
        };
      }
    } catch {
      this.lastPreCompactionBackup = null;
    }
  }

  private ensurePersistentVocabulary(rows: MemoryRow[]): void {
    let repaired = false;
    let status = this.embedder.rebuildPersistentVocabulary();

    if (status.needsRecovery) {
      this.repairCorruptedVocabularyPersistence();
      repaired = true;
      status = this.embedder.rebuildPersistentVocabulary();
    }

    if (rows.length > 0 && (status.docCount === 0 || status.termCount === 0)) {
      status = this.fitVocabularyWithRecovery(rows.map((row) => String(row.content ?? '')));
      repaired = repaired || status.reset;
    }

    if (repaired) {
      console.warn(
        `[MemoryEngine] Repaired derived vocabulary state in ${this.dbPath} after SQLite corruption.`,
      );
    }
  }

  private fitVocabularyWithRecovery(docs: string[]): PersistentVocabularyStatus {
    let status = this.embedder.fitVocabulary(docs);
    if (!status.needsRecovery) {
      return status;
    }

    const snapshot = this.captureMemoryDbSnapshot();
    this.repairCorruptedVocabularyPersistence(snapshot.memories);
    status = this.embedder.fitVocabulary(docs);
    if (status.needsRecovery) {
      throw new Error(
        `[MemoryEngine] Failed to rebuild derived vocabulary state in ${this.dbPath}. ${this.manualRecoveryHint()}`,
      );
    }
    return {
      ...status,
      reset: true,
    };
  }

  private repairCorruptedVocabularyPersistence(memoryRows?: MemoryRow[]): void {
    const snapshot = this.captureMemoryDbSnapshot(memoryRows);
    this.rotateCorruptedMemoryFiles();
    this.reopenMemoryDatabase();
    this.restoreMemoryDbSnapshot(snapshot);
  }

  private captureMemoryDbSnapshot(memoryRows?: MemoryRow[]): MemoryDbSnapshot {
    const memories = memoryRows ?? this.captureMemoryRowsForRepair();
    let memoryLinks: MemoryLinkRow[] = [];
    let tokenLedger: TokenLedgerRow[] = [];
    try {
      memoryLinks = this.db.prepare(
        'SELECT from_id, to_id, weight, type FROM memory_links ORDER BY from_id, to_id'
      ).all() as MemoryLinkRow[];
      tokenLedger = this.db.prepare(
        `SELECT id, session_id, timestamp, task, model, tokens_optimized, tokens_saved,
                tokens_forwarded, compression_ratio, file_count, usd_value_saved
         FROM token_ledger ORDER BY timestamp ASC`
      ).all() as TokenLedgerRow[];
    } catch (error) {
      throw this.createMemoryDbLoadError(error);
    }
    return { memories, memoryLinks, tokenLedger };
  }

  private captureMemoryRowsForRepair(): MemoryRow[] {
    try {
      return this.db.prepare(
        `SELECT * FROM memories ORDER BY priority DESC, timestamp DESC`
      ).all() as MemoryRow[];
    } catch (error) {
      throw this.createMemoryDbLoadError(error);
    }
  }

  private rotateCorruptedMemoryFiles(): void {
    const backupDir = path.join(
      path.dirname(this.dbPath),
      `memory-db-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    );

    this.db.close();
    fs.mkdirSync(backupDir, { recursive: true });
    for (const filePath of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
      if (!fs.existsSync(filePath)) continue;
      fs.renameSync(filePath, path.join(backupDir, path.basename(filePath)));
    }
  }

  private reopenMemoryDatabase(): void {
    this.db = new Database(this.dbPath);
    this.initSchema();
    this.embedder = new Embedder(this.db);
    this.prepareStatements();
  }

  private restoreMemoryDbSnapshot(snapshot: MemoryDbSnapshot): void {
    const insertMemory = this.db.prepare(`
      INSERT INTO memories(
        id, content, priority, timestamp, tags, tier, scope, state, source,
        session_id, access_count, parent_id, depth, entropy, mass, trust,
        qmd_recency, qmd_frequency, qmd_relevance, provenance_json, expires_at,
        supersedes, superseded_by
      ) VALUES (
        @id, @content, @priority, @timestamp, @tags, @tier, @scope, @state, @source,
        @session_id, @access_count, @parent_id, @depth, @entropy, @mass, @trust,
        @qmd_recency, @qmd_frequency, @qmd_relevance, @provenance_json, @expires_at,
        @supersedes, @superseded_by
      )
    `);
    const insertLink = this.db.prepare(`
      INSERT INTO memory_links(from_id, to_id, weight, type)
      VALUES(@from_id, @to_id, @weight, @type)
    `);
    const insertTokenLedger = this.db.prepare(`
      INSERT INTO token_ledger(
        id, session_id, timestamp, task, model, tokens_optimized, tokens_saved,
        tokens_forwarded, compression_ratio, file_count, usd_value_saved
      ) VALUES (
        @id, @session_id, @timestamp, @task, @model, @tokens_optimized, @tokens_saved,
        @tokens_forwarded, @compression_ratio, @file_count, @usd_value_saved
      )
    `);

    const restore = this.db.transaction(() => {
      for (const row of snapshot.memories) {
        insertMemory.run({
          id: row.id,
          content: row.content,
          priority: row.priority,
          timestamp: row.timestamp,
          tags: row.tags,
          tier: row.tier,
          scope: row.scope ?? 'session',
          state: row.state ?? 'active',
          source: row.source ?? 'runtime',
          session_id: row.session_id ?? null,
          access_count: row.access_count ?? 0,
          parent_id: row.parent_id ?? null,
          depth: row.depth ?? 0,
          entropy: row.entropy ?? 0,
          mass: row.mass ?? 1,
          trust: row.trust ?? 0.6,
          qmd_recency: row.qmd_recency ?? null,
          qmd_frequency: row.qmd_frequency ?? null,
          qmd_relevance: row.qmd_relevance ?? null,
          provenance_json: row.provenance_json ?? '{}',
          expires_at: row.expires_at ?? null,
          supersedes: row.supersedes ?? null,
          superseded_by: row.superseded_by ?? null,
        });
      }

      for (const row of snapshot.memoryLinks) {
        insertLink.run(row);
      }

      for (const row of snapshot.tokenLedger) {
        insertTokenLedger.run(row);
      }
    });

    restore();
  }

  private createMemoryDbLoadError(error: unknown): Error {
    if (!isSqliteCorruptionError(error)) {
      return error instanceof Error ? error : new Error(String(error));
    }
    return new Error(
      `[MemoryEngine] Failed to load memories from ${this.dbPath}. Corruption extends beyond derived vocabulary tables. ${this.manualRecoveryHint()}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }

  private manualRecoveryHint(): string {
    return `Move ${this.dbPath}, ${this.dbPath}-wal, and ${this.dbPath}-shm aside and rerun nexus-prime init.`;
  }

  /** Flush prefrontal to DB (called on MCP shutdown) */
  flush(): void {
    try {
      const upsert = this.db.prepare(`
        INSERT INTO memories(id, content, priority, timestamp, tags, tier, scope, state, source, session_id, access_count, parent_id, depth, entropy, mass, trust, provenance_json, expires_at, supersedes, superseded_by)
      VALUES(@id, @content, @priority, @timestamp, @tags, @tier, @scope, @state, @source, @session_id, @access_count, @parent_id, @depth, @entropy, @mass, @trust, @provenance_json, @expires_at, @supersedes, @superseded_by)
        ON CONFLICT(id) DO UPDATE SET
      priority = excluded.priority,
        access_count = excluded.access_count,
        tier = excluded.tier,
        scope = excluded.scope,
        state = excluded.state,
        source = excluded.source,
        parent_id = excluded.parent_id,
        depth = excluded.depth,
        entropy = excluded.entropy,
        mass = excluded.mass,
        trust = excluded.trust,
        provenance_json = excluded.provenance_json,
        expires_at = excluded.expires_at,
        supersedes = excluded.supersedes,
        superseded_by = excluded.superseded_by
          `);

      const txn = this.db.transaction((items: MemoryItem[]) => {
        for (const item of items) {
          // Sanitize fields to prevent type errors
          upsert.run({
            id: String(item.id),
            content: String(item.content),
            priority: Number(item.priority) || 0,
            timestamp: Number(item.timestamp) || Date.now(),
            tags: JSON.stringify(Array.isArray(item.tags) ? item.tags : []),
            tier: String(item.tier || 'prefrontal'),
            scope: String(item.scope || 'session'),
            state: String(item.state || 'active'),
            source: String(item.source || 'runtime'),
            session_id: item.sessionId ? String(item.sessionId) : null,
            access_count: Number(item.accessCount) || 0,
            parent_id: item.parentId ? String(item.parentId) : null,
            depth: Number(item.depth) || 0,
            entropy: Number(item.entropy) || 0,
            mass: Number(item.mass) || 1.0,
            trust: Number(item.trust) || 0.6,
            provenance_json: JSON.stringify(item.provenance ?? createMemoryProvenance({
              source: item.source ?? 'runtime',
              sessionId: item.sessionId,
              tags: item.tags,
              summary: 'Recovered memory item',
            })),
            expires_at: item.expiresAt ?? null,
            supersedes: item.supersedes ?? null,
            superseded_by: item.supersededBy ?? null,
          });
        }
      });

      txn(this.prefrontal);
    } catch (err) {
      console.error('[MemoryEngine] flush() error:', err);
    }
  }

  /** Alias for flush() that delegates to SQLite transaction immediately, tracking stats */
  preCompactionFlush(reason: string): void {
    if (this.shouldCreatePreCompactionBackup(reason)) {
      this.createPreCompactionBackup(reason);
    }
    const itemsFlushed = this.prefrontal.length;
    if (itemsFlushed > 0) {
      this.flush();
    }
    this.flushVaultSync();
    nexusEventBus.emit('memory.flushed', {
      count: itemsFlushed,
      reason,
      ts: Date.now(),
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Core Operations
  // ─────────────────────────────────────────────────────────────────────────

  store(
    content: string,
    priority: number = 1.0,
    tags: string[] = [],
    parentId?: string,
    depth: number = 0,
    options: {
      sessionId?: string;
      timestamp?: number;
      tier?: MemoryItem['tier'];
      scope?: MemoryItem['scope'];
      state?: MemoryItem['state'];
      source?: MemoryItem['source'];
      trust?: number;
      expiresAt?: number;
      supersedes?: string;
      supersededBy?: string;
      provenance?: Partial<MemoryProvenance>;
    } = {},
  ): string {
    const id = randomUUID();
    const normalizedTags = dedupeStrings(tags);
    const check = this.checkContent(content, {
      tags: normalizedTags,
      priority,
      parentId,
    });
    const scope = options.scope ?? this.inferScope(normalizedTags, priority);
    const state = options.state ?? this.inferState(normalizedTags, check, priority);
    const source = options.source ?? this.inferSource(normalizedTags);
    const tier = options.tier ?? 'prefrontal';
    const timestamp = options.timestamp ?? Date.now();
    const sessionId = options.sessionId ?? this.sessionId;
    const trust = Number(options.trust ?? this.estimateTrust(normalizedTags, check, priority));
    const lane = this.inferLane(normalizedTags, source);
    const provenance = createMemoryProvenance({
      source,
      sessionId,
      tags: normalizedTags,
      references: this.extractReferenceIds(content, sessionId),
      summary: options.provenance?.summary ?? `${source} memory`,
      runId: options.provenance?.runId,
      workerId: options.provenance?.workerId,
      workspaceId: options.provenance?.workspaceId,
      repoId: options.provenance?.repoId ?? resolveCurrentRepoId(),
      projectId: options.provenance?.projectId,
      lane: options.provenance?.lane ?? lane,
      containerTags: options.provenance?.containerTags ?? normalizedTags.filter((tag) => /^#(?:repo|project|workspace|hidden|profile|inbox)/.test(tag)),
      toolName: options.provenance?.toolName,
    });
    const item: MemoryItem = {
      id,
      content,
      priority,
      timestamp,
      tags: state === 'quarantined' && !normalizedTags.includes('#quarantine')
        ? [...normalizedTags, '#quarantine']
        : normalizedTags,
      tier,
      scope,
      state,
      source,
      sessionId,
      accessCount: 0,
      parentId,
      depth,
      entropy: 0.0,
      mass: priority,
      trust,
      expiresAt: options.expiresAt,
      supersedes: options.supersedes,
      supersededBy: options.supersededBy,
      provenance,
    };

    // Write to DB immediately (don't wait for flush)
    this.db.prepare(`
      INSERT INTO memories(id, content, priority, timestamp, tags, tier, scope, state, source, session_id, access_count, parent_id, depth, entropy, mass, trust, provenance_json, expires_at, supersedes, superseded_by)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0.0, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        content,
        priority,
        item.timestamp,
        JSON.stringify(item.tags),
        item.tier,
        item.scope,
        item.state,
        item.source,
        item.sessionId,
        parentId,
        depth,
        priority,
        item.trust,
        JSON.stringify(item.provenance),
        item.expiresAt ?? null,
        item.supersedes ?? null,
        item.supersededBy ?? null,
      );

    if (item.supersedes) {
      this.db.prepare('UPDATE memories SET superseded_by = ?, state = ? WHERE id = ?').run(id, 'expired', item.supersedes);
    }

    // Update vocabulary and add to vector index
    this.fitVocabularyWithRecovery([content]);
    this.indexMemory(id, content);

    // Index in n-gram index for fast text search
    try { this.ngramIndex?.addDocument(id, content); } catch { /* best-effort */ }

    // Auto-link to semantically similar recent memories
    this.autoLink(item);


    // Add to RAM prefrontal
    if (item.tier === 'prefrontal') {
      this.prefrontal.push(item);
    }

    if (this.prefrontal.length > this.maxPrefrontal) {
      this.consolidate();
    }

    // Fission: broadcast high-value memories
    if (priority > 0.9) {
      this.fission(item);
    }

    nexusEventBus.emit('memory.store', {
      id,
      priority: item.priority,
      tags: item.tags,
      tier: item.tier,
    });
    this.markVaultDirty(id);
    this.mirrorIntoGraph(item);

    return id;
  }

  storeWithControlPlane(
    content: string,
    priority: number = 0.7,
    tags: string[] = [],
    parentId?: string,
    depth: number = 0,
    options: {
      sessionId?: string;
      timestamp?: number;
      scope?: MemoryItem['scope'];
      state?: MemoryItem['state'];
      source?: MemoryItem['source'] | 'rag';
      provenance?: Partial<MemoryProvenance>;
      defaultTtlMs?: number;
      maxCandidates?: number;
    } = {},
  ): { storedIds: string[]; summary: MemoryReconciliationSummary } {
    const candidates = deriveCandidateFacts(content, tags, options.maxCandidates ?? 2);
    const summary = createEmptyReconciliationSummary();
    const storedIds: string[] = [];

    for (const candidate of candidates) {
      const decision = this.reconcileCandidate(candidate, {
        parentId,
        priority,
        sessionId: options.sessionId,
      });
      summary.actionCounts[decision.action] += 1;
      const expiresAt = candidate.ephemeral || (options.defaultTtlMs ?? 0) > 0
        ? Date.now() + (options.defaultTtlMs ?? 3 * 24 * 60 * 60 * 1000)
        : undefined;
      const candidateLane = this.inferLane(candidate.tags, options.source === 'rag' ? 'imported' : (options.source ?? 'runtime'));
      let storedId: string | undefined;
      if (decision.action === 'ADD' || decision.action === 'UPDATE' || decision.action === 'MERGE' || decision.action === 'QUARANTINE') {
        storedId = this.store(candidate.content, priority, candidate.tags, parentId, depth, {
          sessionId: options.sessionId,
          timestamp: options.timestamp,
          scope: options.scope,
          state: decision.action === 'QUARANTINE'
            ? 'quarantined'
            : candidateLane === 'inbox'
              ? 'quarantined'
              : options.state,
          source: options.source === 'rag' ? 'imported' : options.source,
          trust: Math.max(0.25, Math.min(0.98, candidate.confidence)),
          expiresAt,
          supersedes: decision.action === 'UPDATE' ? decision.relatedIds[0] : undefined,
          provenance: {
            ...options.provenance,
            source: options.source === 'rag' ? 'rag' : (options.source ?? 'runtime'),
            summary: options.provenance?.summary ?? `${decision.action} via memory control plane`,
            tags: dedupeStrings([...(options.provenance?.tags ?? []), ...candidate.tags]),
            references: dedupeStrings([...(options.provenance?.references ?? []), ...decision.relatedIds]),
            lane: options.provenance?.lane ?? candidateLane,
          },
        });
        storedIds.push(storedId);
      } else if (decision.action === 'DELETE') {
        decision.relatedIds.forEach((relatedId) => {
          this.db.prepare('UPDATE memories SET state = ?, superseded_by = ? WHERE id = ?').run('expired', 'deleted-by-policy', relatedId);
        });
      }
      summary.entries.push({
        candidate: candidate.content,
        action: decision.action,
        reason: decision.reason,
        relatedIds: decision.relatedIds,
        storedId,
        expiresAt,
      });
    }

    this.lastReconciliationSummary = {
      ...summary,
      generatedAt: Date.now(),
    };
    this.syncVault(true);
    return { storedIds, summary: this.lastReconciliationSummary };
  }

  async recall(query: string, k: number = 5, filters: MemoryRecallFilters = {}): Promise<string[]> {
    this.expireMemories();
    const now = Date.now();

    // ── N-gram pre-filter: narrow candidates before full scan ─────────────
    let candidateRows: any[];
    const ngramCandidates = this.ngramIndex?.search(query, this.config.recallCandidateLimit);
    if (ngramCandidates && ngramCandidates.length > 0) {
      const ids = ngramCandidates.map((c) => c.docId);
      const placeholders = ids.map(() => '?').join(',');
      candidateRows = this.db.prepare(`
        SELECT *
        FROM memories
        WHERE id IN (${placeholders})
          AND state = 'active'
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY priority DESC, timestamp DESC
      `).all(...ids, now) as any[];
      // If n-gram returned too few, supplement with priority-based scan
      if (candidateRows.length < k * 2) {
        const existingIds = new Set(candidateRows.map((r: any) => r.id));
        const supplement = this.db.prepare(`
          SELECT *
          FROM memories
          WHERE state = 'active'
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY priority DESC, timestamp DESC
          LIMIT ?
        `).all(now, this.config.recallCandidateLimit) as any[];
        for (const row of supplement) {
          if (!existingIds.has(row.id)) {
            candidateRows.push(row);
            existingIds.add(row.id);
          }
        }
      }
    } else {
      candidateRows = this.db.prepare(`
        SELECT *
        FROM memories
        WHERE state = 'active'
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY priority DESC, timestamp DESC
        LIMIT ?
      `).all(now, this.config.recallCandidateLimit) as any[];
    }
    const candidateItems = candidateRows
      .map((row) => this.rowToItem(row))
      .filter((item) => this.matchesRecallFilters(item, filters));
    // ── Stage 1: Vector search (semantic) ────────────────────────────────────
    const queryVector = await this.embedder.embed(query);
    const vectorMatches: Map<string, number> = new Map();

    for (const item of candidateItems) {
      const itemVector = this.embedder.localEmbed(item.content);
      const hDist = HyperbolicMath.dist(queryVector, itemVector);
      let score = 1 / (1 + hDist);

      // Hierarchy Boost: if item has a parent that matches query, boost child
      if (item.parentId) {
        const parent = candidateItems.find(i => i.id === item.parentId);
        if (parent) {
          const parentVector = this.embedder.localEmbed(parent.content);
          const pDist = HyperbolicMath.dist(queryVector, parentVector);
          if (pDist < 0.3) score *= 1.4; // Boost child if parent is relevant
        }
      }
      vectorMatches.set(item.id, score);
    }

    // ── Stage 2: SQL scoring (priority + recency) ─────────────────────────────
    const podFindings = podNetwork.recall([]);
    const queryLower = query.toLowerCase();

    const scored = candidateItems.map((item) => {
      const vectorScore = vectorMatches.get(item.id) ?? 0;
      const recencyScore = Math.exp(-(now - item.timestamp) / (7 * 24 * 3600 * 1000));
      const priorityScore = item.priority;
      const accessBonus = Math.min(item.accessCount * 0.05, 0.3);
      const massBoost = (item.mass ?? 1.0) * 0.2;
      const qmdScore = this.computeQmdScore(item);

      return {
        content: item.content,
        id: item.id,
        score: vectorScore * 0.4 + priorityScore * 0.15 + recencyScore * 0.1 + accessBonus * 0.05 + massBoost + qmdScore * 0.3,
      };
    });

    const podMatches = podFindings
      .filter(f => f.content.toLowerCase().includes(queryLower))
      .map(f => ({ content: f.content, score: 0.95 }));

    const graphMatches = this.graphMirror ? await this.graphMirror.recall(query, k) : [];
    const graphScored = graphMatches.map((content, index) => ({
      content,
      score: 0.35 - index * 0.01,
    }));

    const top = [...scored, ...podMatches, ...graphScored]
      .sort((a, b) => (b.score as number) - (a.score as number))
      .filter((entry, index, all) => all.findIndex((candidate) => candidate.content === entry.content) === index)
      .slice(0, k);

    // Increment access count for recalled items
    if (top.length > 0) {
      const ids = top.flatMap((entry) => {
        const candidateId = (entry as { id?: string }).id;
        return typeof candidateId === 'string' ? [candidateId] : [];
      });
      if (ids.length > 0) {
        this.incrementAccessTxn(ids);
      }
    }

    return top.map(r => r.content);
  }

  /** Promote a memory to 'shared' scope so it becomes visible across all repos */
  shareMemory(id: string): boolean {
    const item = this.getById(id);
    if (!item) return false;
    this.db.prepare(`UPDATE memories SET scope = 'shared' WHERE id = ?`).run(id);
    this.markVaultDirty(id);
    return true;
  }

  /** Compact vault by merging individual item files into a single snapshot */
  compactVault(): { itemsMerged: number; snapshotPath: string } | null {
    if (!fs.existsSync(this.vaultItemsDir)) return null;
    const files = fs.readdirSync(this.vaultItemsDir).filter(f => f.endsWith('.json'));
    if (files.length <= 10) return null;
    const consolidated: any[] = [];
    for (const file of files) {
      try {
        consolidated.push(JSON.parse(fs.readFileSync(path.join(this.vaultItemsDir, file), 'utf8')));
        fs.unlinkSync(path.join(this.vaultItemsDir, file));
      } catch { /* skip corrupted files */ }
    }
    const snapshotPath = path.join(this.vaultDir, `vault-snapshot-${Date.now()}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify(consolidated, null, 2));
    return { itemsMerged: consolidated.length, snapshotPath };
  }

  checkContent(content: string, options: {
    tags?: string[];
    priority?: number;
    parentId?: string;
  } = {}): MemoryCheckResult {
    const normalized = content.trim().toLowerCase();
    const words = normalized.split(/\W+/).filter(Boolean);
    const findings: MemoryCheckFinding[] = [];
    const duplicateCluster: string[] = [];
    const allItems = this.listContentCheckCandidates();

    for (const item of allItems) {
      const candidateWords = item.content.toLowerCase().split(/\W+/).filter(Boolean);
      const overlap = this.wordOverlap(words, candidateWords);
      if (item.content.trim().toLowerCase() === normalized || overlap >= 0.86) {
        duplicateCluster.push(item.id);
      }

      const newNegated = /\b(not|never|no longer|cannot|can't)\b/i.test(content);
      const oldNegated = /\b(not|never|no longer|cannot|can't)\b/i.test(item.content);
      if (overlap >= 0.42 && newNegated !== oldNegated) {
        findings.push({
          id: `contradiction:${item.id}`,
          severity: 'medium',
          category: 'contradiction',
          message: 'Potential contradiction with an existing memory on the same topic.',
          relatedIds: [item.id],
        });
      }
    }

    if (duplicateCluster.length > 0) {
      findings.push({
        id: 'duplicate-cluster',
        severity: duplicateCluster.length > 1 ? 'medium' : 'low',
        category: 'duplicate',
        message: 'Content is highly similar to one or more existing memories.',
        relatedIds: duplicateCluster,
      });
    }

    if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
      findings.push({
        id: 'secret-pattern',
        severity: 'high',
        category: 'secret',
        message: 'Potential secret-bearing content detected.',
        relatedIds: [],
      });
    }

    if (/(guaranteed|100%\\s*(roi|secure|accurate|success)|always works|fully compliant)/i.test(content)) {
      findings.push({
        id: 'unsupported-claim',
        severity: 'medium',
        category: 'claim',
        message: 'Potential unsupported claim detected in memory content.',
        relatedIds: [],
      });
    }

    const entropyScore = this.estimateEntropy(words);
    if (entropyScore > 0.82) {
      findings.push({
        id: 'entropy-noise',
        severity: 'low',
        category: 'entropy',
        message: 'Memory content appears noisy or low-signal.',
        relatedIds: [],
      });
    }

    if ((options.tags?.length ?? 0) === 0 && !options.parentId && (options.priority ?? 0) < 0.7) {
      findings.push({
        id: 'low-provenance',
        severity: 'low',
        category: 'provenance',
        message: 'Memory has weak provenance and should remain session-scoped until revalidated.',
        relatedIds: [],
      });
    }

    const action = findings.some((finding) => finding.severity === 'high')
      ? 'block'
      : findings.some((finding) => finding.severity === 'medium')
        ? 'quarantine'
        : findings.some((finding) => finding.severity === 'low')
          ? 'warn'
          : 'allow';

    return {
      contentPreview: content.length > 140 ? `${content.slice(0, 137)}...` : content,
      action,
      findings,
      duplicateCluster,
      canPromote: action === 'allow' || action === 'warn',
    };
  }

  audit(limit: number = 80): MemoryAuditResult {
    const snapshots = this.listSnapshots(limit);
    const findings = snapshots.map((snapshot) => ({
      id: snapshot.id,
      ...this.checkContent(this.getDetail(snapshot.id)?.content ?? snapshot.excerpt, {
        tags: snapshot.tags,
        priority: snapshot.priority,
        parentId: snapshot.parentId,
      }),
    }));

    return {
      scanned: findings.length,
      quarantined: snapshots.filter((snapshot) =>
        snapshot.tags.includes('#quarantine') ||
        findings.some((finding) => finding.id === snapshot.id && (finding.action === 'quarantine' || finding.action === 'block'))
      ),
      findings,
    };
  }

  listQuarantined(limit: number = 40): MemorySnapshot[] {
    return this.audit(limit * 2).quarantined.slice(0, Math.max(limit, 1));
  }

  getLastReconciliationSummary(): MemoryReconciliationSummary {
    return this.lastReconciliationSummary;
  }

  maintain(): MemoryMaintenanceResult {
    this.expireMemories();
    const before = this.getStateCounts();
    const cooled = this.db.prepare(`
      UPDATE memories
      SET entropy = MIN(entropy + 0.03, 1.0),
          priority = CASE WHEN state = 'active' THEN priority * 0.98 ELSE priority END,
          state = CASE
            WHEN state = 'active' AND trust < 0.35 THEN 'quarantined'
            WHEN state = 'active' AND entropy > 0.88 THEN 'scrap'
            ELSE state
          END
      WHERE state != 'expired'
    `).run().changes;
    const after = this.getStateCounts();
    this.syncVault(true);
    return {
      generatedAt: Date.now(),
      expired: (after.expired ?? 0) - (before.expired ?? 0),
      cooled,
      quarantined: after.quarantined ?? 0,
      scrapMarked: after.scrap ?? 0,
      retained: after.active ?? 0,
    };
  }

  trace(id: string): MemoryTraceDetail | undefined {
    const detail = this.getDetail(id);
    if (!detail) return undefined;
    const reconciliation = this.lastReconciliationSummary.entries.find((entry) => entry.storedId === id)
      ?? (detail.supersedes || detail.supersededBy
        ? {
            candidate: detail.content,
            action: detail.supersedes ? 'UPDATE' : 'MERGE',
            reason: detail.supersedes ? `Supersedes ${detail.supersedes}` : `Superseded by ${detail.supersededBy}`,
            relatedIds: [detail.supersedes || detail.supersededBy || ''].filter(Boolean),
            storedId: detail.id,
            expiresAt: detail.expiresAt,
          } satisfies MemoryReconciliationEntry
        : undefined);
    return {
      ...detail,
      reconciliation,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Vector Index Helpers
  // ─────────────────────────────────────────────────────────────────────────

  // In-RAM embedding store (id → float[] vector)
  private vectorEmbeddings: Map<number, number[]> = new Map();

  private indexMemory(memoryId: string, content: string): void {
    const vector = this.embedder.localEmbed(content);
    const vid = this.nextVectorId++;
    this.vectorEmbeddings.set(vid, vector);
    this.vectorIdToMemoryId.set(vid, memoryId);
    this.memoryIdToVectorId.set(memoryId, vid);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Zettelkasten — semantic linking
  // ─────────────────────────────────────────────────────────────────────────

  private autoLink(newItem: MemoryItem): void {
    const recentRows = this.db.prepare(`
      SELECT id, content, tags FROM memories
      WHERE id != ? AND state = 'active' ORDER BY timestamp DESC LIMIT 100
      `).all(newItem.id) as any[];

    const newWords = newItem.content.toLowerCase().split(/\s+/);
    const newVector = this.embedder.localEmbed(newItem.content);

    for (const row of recentRows) {
      const existingWords = (row.content as string).toLowerCase().split(/\s+/);
      const lexicalOverlap = this.wordOverlap(newWords, existingWords);
      
      const rowVector = this.embedder.localEmbed(row.content as string);
      const hDist = HyperbolicMath.dist(newVector, rowVector);
      const semanticSimilarity = 1 / (1 + hDist);

      const similarity = Math.max(lexicalOverlap, semanticSimilarity);

      if (similarity > 0.25) {
        this.db.prepare(`
          INSERT OR IGNORE INTO memory_links(from_id, to_id, weight, type)
    VALUES(?, ?, ?, 'semantic')
      `).run(newItem.id, row.id, similarity);
      }

      // Tag-based linking
      const sharedTags = newItem.tags.filter(t =>
        JSON.parse(row.tags as string ?? '[]').includes(t)
      );
      if (sharedTags.length > 0) {
        this.db.prepare(`
          INSERT OR IGNORE INTO memory_links(from_id, to_id, weight, type)
    VALUES(?, ?, ?, 'tagged')
      `).run(newItem.id, row.id, 0.6 + sharedTags.length * 0.1);
      }
    }
  }

  autoLinkBatch(items: MemoryItem[]): void {
    for (const item of items) {
      this.autoLink(item);
    }
  }

  /** Get a memory's connected context network */
  getNetwork(id: string, depth: number = 1): MemoryItem[] {
    const visited = new Set<string>([id]);
    const result: MemoryItem[] = [];
    let frontier = [id];

    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const fromId of frontier) {
        const links = this.db.prepare(`
          SELECT to_id FROM memory_links WHERE from_id = ? ORDER BY weight DESC LIMIT 5
      `).all(fromId) as any[];

        for (const link of links) {
          const toId = link.to_id as string;
          if (!visited.has(toId)) {
            visited.add(toId);
            next.push(toId);
            const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(toId) as any;
            if (row) result.push(this.rowToItem(row));
          }
        }
      }
      frontier = next;
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Fission: broadcast high-value discoveries
  // ─────────────────────────────────────────────────────────────────────────

  private fission(item: MemoryItem): void {
    // Promote to cortex immediately (permanently important)
    this.db.prepare(`
      UPDATE memories SET tier = 'cortex', scope = 'promoted', priority = MIN(priority * 1.2, 2.0), mass = MIN(mass * 1.5, 5.0)
      WHERE id = ?
      `).run(item.id);

    // Broadcast via POD network if priority is exceptionally high
    if (item.priority > 0.95) {
      podNetwork.publish(
        'NexusAgent',
        item.content,
        item.priority,
        [...item.tags, '#fission']
      );
    }

    // Strengthen links TO this item (makes it easier to discover via related queries)
    this.db.prepare(`
      UPDATE memory_links SET weight = MIN(weight * 1.3, 1.0) WHERE to_id = ?
      `).run(item.id);
    this.markVaultDirty(item.id);
  }

  /** Periodic cooling cycle: increases entropy and decays priority */
  coolDown(): void {
    const { decayRate, priorityRetention } = this.config;
    
    this.db.prepare(`
      UPDATE memories
      SET entropy = MAX(0.0, MIN(1.0, entropy + ?)),
          priority = priority * ?
      WHERE tier != 'cortex'
    `).run(decayRate, priorityRetention);

    // Apply access-frequency retention: frequently accessed memories decay slower
    this.db.prepare(`
      UPDATE memories
      SET entropy = MAX(0.0, MIN(1.0, entropy - (? / (1.0 + CAST(access_count AS REAL) * 0.1))))
      WHERE tier != 'cortex' AND access_count > 0
    `).run(decayRate);

    // Force flush high entropy items (this will promote/demote based on priority)
    this.consolidate();
    this.syncVault(true);
  }

  /** Maintenance cycle: runs coolDown() then expires memories where entropy > threshold AND accessCount < 2 AND age > 7 days */
  maintenanceCycle(): void {
    this.coolDown();
    this.backgroundLinkMaintenance();
    
    const { flushEntropyThreshold } = this.config;
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    
    this.db.prepare(`
      UPDATE memories
      SET state = 'expired'
      WHERE state = 'active'
        AND entropy > ?
        AND access_count < 2
        AND timestamp < ?
    `).run(flushEntropyThreshold, sevenDaysAgo);
    
    this.syncVault(true);
  }

  backgroundLinkMaintenance(): void {
    // Prune weak links
    this.db.exec(`
      DELETE FROM memory_links WHERE weight < 0.1
    `);
    // Decay links slightly to forget unused connections
    this.db.exec(`
      UPDATE memory_links SET weight = weight * 0.95
    `);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tier Management
  // ─────────────────────────────────────────────────────────────────────────

  private consolidate(): void {
    const sorted = [...this.prefrontal].sort((a, b) => b.priority - a.priority);
    const keepInRam = sorted.slice(0, Math.ceil(this.maxPrefrontal / 2));
    const toPromote = sorted.slice(Math.ceil(this.maxPrefrontal / 2));

    this.prefrontal = keepInRam;

    if (toPromote.length > 0) {
      const promoteStmt = this.db.prepare(
        `UPDATE memories SET tier = 'hippocampus' WHERE id = ? `
      );
      const txn = this.db.transaction((items: MemoryItem[]) => {
        for (const item of items) {
          promoteStmt.run(item.id);
          item.tier = 'hippocampus';
        }
      });
      txn(toPromote);
    }

    // Compact hippocampus to cortex if overfull
    const hippoCount = (this.db.prepare(
      `SELECT COUNT(*) as c FROM memories WHERE tier = 'hippocampus'`
    ).get() as any).c as number;

    if (hippoCount > this.maxHippocampus) {
      this.db.prepare(`
        UPDATE memories SET tier = 'cortex'
        WHERE tier = 'hippocampus'
        AND id IN(
        SELECT id FROM memories WHERE tier = 'hippocampus'
          ORDER BY priority DESC LIMIT ?
        )
      `).run(hippoCount - this.maxHippocampus);
    }
    this.syncVault(true);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────

  private inferScope(tags: string[], priority: number): MemoryItem['scope'] {
    if (tags.includes('#shared') || tags.includes('#worker-shared')) return 'shared';
    if (tags.includes('#workspace') || tags.includes('#repo-profile') || tags.some((tag) => tag.startsWith('#repo:')) || tags.some((tag) => tag.startsWith('#project:'))) return 'project';
    if (tags.includes('#project')) return 'project';
    if (tags.includes('#user')) return 'user';
    if (tags.includes('#promoted') || priority >= 0.92) return 'promoted';
    return 'session';
  }

  private inferState(tags: string[], check: MemoryCheckResult, priority: number): MemoryItem['state'] {
    if (tags.includes('#quarantine') || check.action === 'block' || check.action === 'quarantine') {
      return 'quarantined';
    }
    if (tags.includes('#scrap')) return 'scrap';
    if (check.findings.some((finding) => finding.category === 'entropy') && priority < 0.65) {
      return 'scrap';
    }
    return 'active';
  }

  private inferSource(tags: string[]): MemoryItem['source'] {
    if (tags.includes('#imported')) return 'imported';
    if (tags.includes('#worker') || tags.includes('#worker-shared')) return 'worker';
    if (tags.includes('#operator')) return 'operator';
    if (tags.includes('#system')) return 'system';
    return 'runtime';
  }

  private inferLane(tags: string[], source: MemoryItem['source']): MemoryContainerLane {
    if (tags.includes('#shared') || tags.includes('#worker-shared')) return 'shared';
    if (tags.includes('#profile') || tags.includes('#user') || tags.includes('#operator-preference')) return 'profile';
    if (tags.includes('#inbox') || tags.includes('#quarantine') || tags.includes('#runtime-result')) return 'inbox';
    if (source === 'worker' && !tags.includes('#shared')) return 'workspace';
    return 'workspace';
  }

  private isHiddenMemory(tags: string[]): boolean {
    return tags.includes('#hidden') || tags.includes('#system-hidden') || tags.includes('#repo-profile');
  }

  private matchesContainerFilters(provenance: MemoryProvenance, filters: {
    repoId?: string;
    workspaceId?: string;
    projectId?: string;
    lane?: MemoryContainerLane;
  }): boolean {
    if (filters.repoId && provenance.repoId !== filters.repoId) return false;
    if (filters.workspaceId && provenance.workspaceId !== filters.workspaceId) return false;
    if (filters.projectId && provenance.projectId !== filters.projectId) return false;
    if (filters.lane && provenance.lane !== filters.lane) return false;
    return true;
  }

  private matchesRecallFilters(item: MemoryItem, filters: MemoryRecallFilters): boolean {
    if (!filters.includeHidden && this.isHiddenMemory(item.tags)) return false;
    if (!this.matchesContainerFilters(item.provenance, filters)) return false;
    const lane = item.provenance.lane ?? this.inferLane(item.tags, item.source);
    if (filters.lane && lane !== filters.lane) return false;
    if (filters.sessionId && item.scope === 'session' && item.sessionId !== filters.sessionId) return false;
    if (filters.includeShared === false && lane === 'shared') return false;
    if (filters.includeProfile === false && lane === 'profile') return false;
    if ((filters.repoId || filters.projectId || filters.workspaceId) && lane === 'workspace') {
      const matchAny = Boolean(
        (filters.repoId && item.provenance.repoId === filters.repoId)
        || (filters.projectId && item.provenance.projectId === filters.projectId)
        || (filters.workspaceId && item.provenance.workspaceId === filters.workspaceId),
      );
      if (!matchAny) return false;
    }
    if ((filters.repoId || filters.projectId || filters.workspaceId) && lane === 'shared') {
      return Boolean(filters.includeShared);
    }
    return true;
  }

  private shouldCreatePreCompactionBackup(reason: string): boolean {
    return /(compaction|compact|summary|model|compression|budget|sentinel|flush-before-summary|test-compaction)/i.test(reason)
      && !/(dispose|periodic)/i.test(reason);
  }

  private createPreCompactionBackup(reason: string): void {
    const backup = this.backupBundle({ limit: 2000 });
    const snapshot: MemoryBackupSnapshot = {
      timestamp: backup.bundle.exportedAt,
      reason,
      path: backup.path,
      itemCount: backup.bundle.items.length,
    };
    this.lastPreCompactionBackup = snapshot;
    fs.writeFileSync(this.backupMetadataPath, JSON.stringify(snapshot, null, 2), 'utf8');
  }

  private parseRawTags(rawTags?: string): string[] {
    try {
      return JSON.parse(rawTags ?? '[]');
    } catch {
      return [];
    }
  }

  private estimateTrust(tags: string[], check: MemoryCheckResult, priority: number): number {
    const provenancePenalty = check.findings.some((finding) => finding.category === 'provenance') ? 0.18 : 0;
    const contradictionPenalty = check.findings.some((finding) => finding.category === 'contradiction') ? 0.22 : 0;
    const entropyPenalty = check.findings.some((finding) => finding.category === 'entropy') ? 0.12 : 0;
    const sourceBoost = tags.includes('#shared') || tags.includes('#worker-shared') ? 0.06 : 0;
    return Math.max(0.1, Math.min(0.99, priority * 0.62 + sourceBoost - provenancePenalty - contradictionPenalty - entropyPenalty));
  }

  private relevanceScore(item: MemoryItem): number {
    return Math.max(0, Math.min(
      1,
      item.priority * 0.35
      + Math.min(item.accessCount * 0.06, 0.2)
      + (1 - item.entropy) * 0.3
      + Math.min(item.mass * 0.08, 0.15)
      + Math.min(item.trust * 0.12, 0.12),
      1,
    ));
  }

  private importanceScore(item: MemoryItem): number {
    const tierBoost = item.tier === 'cortex' ? 0.25 : item.tier === 'hippocampus' ? 0.12 : 0.04;
    const scopeBoost = item.scope === 'promoted' ? 0.18 : item.scope === 'shared' ? 0.1 : 0;
    return Math.max(0, Math.min(1, item.priority * 0.45 + tierBoost + scopeBoost + Math.min(item.mass * 0.08, 0.18) + Math.min(item.trust * 0.08, 0.08)));
  }

  private freshnessScore(item: MemoryItem): number {
    const horizon = item.expiresAt
      ? Math.max(1, item.expiresAt - item.timestamp)
      : 30 * 24 * 60 * 60 * 1000;
    const age = Date.now() - item.timestamp;
    return Math.max(0, Math.min(1, 1 - (age / horizon)));
  }

  private syncVault(force: boolean = false): void {
    if (force) {
      this.vaultNeedsFullSync = true;
    }
    if (!this.vaultFlushTimer) {
      this.vaultFlushTimer = setTimeout(() => {
        this.flushDirtyVault();
      }, 2000);
      this.vaultFlushTimer.unref();
    }
  }

  public flushVaultSync(): void {
    if (this.vaultFlushTimer) {
      clearTimeout(this.vaultFlushTimer);
      this.vaultFlushTimer = undefined;
    }
    this.flushDirtyVault(true);
  }

  private markVaultDirty(id: string): void {
    this.vaultDirty.add(id);
    this.syncVault(false);
  }

  private flushDirtyVault(force: boolean = false): void {
    this.vaultFlushTimer = undefined;
    if (force || this.vaultNeedsFullSync || this.vaultDirty.size === 0) {
      this.syncVaultFull();
      this.vaultDirty.clear();
      this.vaultNeedsFullSync = false;
      return;
    }

    this.expireMemories();
    const ids = [...this.vaultDirty];
    this.vaultDirty.clear();
    const items = ids
      .map((id) => this.getById(id))
      .filter((item): item is MemoryItem => Boolean(item));
    const currentIds = new Set(items.map((item) => item.id));

    for (const item of items) {
      this.writeVaultItem(item);
    }

    for (const id of ids) {
      if (!currentIds.has(id)) {
        this.removeVaultItem(id);
      }
    }

    fs.writeFileSync(path.join(this.vaultDir, 'index.json'), JSON.stringify({
      generatedAt: Date.now(),
      sessionId: this.sessionId,
      total: this.getTotalMemoryCount(),
      health: this.getHealthSummary(),
      items: this.listVaultIndexItems(),
    }, null, 2), 'utf8');
  }

  private syncVaultFull(): void {
    this.expireMemories();
    const items = this.getAllItems();
    const seen = new Set<string>();
    const memoryNotesDir = path.join(this.vaultNotesDir, 'memories');
    const noteSeen = new Set<string>();
    for (const item of items) {
      seen.add(item.id);
      this.writeVaultItem(item);
      const notePath = path.join(memoryNotesDir, `${item.id}.md`);
      noteSeen.add(notePath);
    }
    for (const entry of fs.readdirSync(this.vaultItemsDir)) {
      if (!entry.endsWith('.json')) continue;
      const memoryId = entry.replace(/\.json$/, '');
      if (!seen.has(memoryId)) {
        fs.unlinkSync(path.join(this.vaultItemsDir, entry));
      }
    }
    for (const entry of fs.readdirSync(memoryNotesDir)) {
      const notePath = path.join(memoryNotesDir, entry);
      if (!noteSeen.has(notePath)) {
        fs.unlinkSync(notePath);
      }
    }
    this.projectEntityNotes(items);
    this.projectSessionNotes(items);
    fs.writeFileSync(path.join(this.vaultDir, 'index.json'), JSON.stringify({
      generatedAt: Date.now(),
      sessionId: this.sessionId,
      total: items.length,
      health: this.getHealthSummary(),
      items: this.listVaultIndexItems(),
    }, null, 2), 'utf8');
  }

  private writeVaultItem(item: MemoryItem): void {
    fs.writeFileSync(
      path.join(this.vaultItemsDir, `${item.id}.json`),
      JSON.stringify({
        ...item,
        excerpt: item.content.length > 140 ? `${item.content.slice(0, 137)}...` : item.content,
        relevanceScore: this.relevanceScore(item),
        importanceScore: this.importanceScore(item),
        freshnessScore: this.freshnessScore(item),
        trustScore: item.trust,
      }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(this.vaultNotesDir, 'memories', `${item.id}.md`),
      this.renderMemoryNote(item),
      'utf8',
    );
  }

  private removeVaultItem(id: string): void {
    const jsonPath = path.join(this.vaultItemsDir, `${id}.json`);
    const notePath = path.join(this.vaultNotesDir, 'memories', `${id}.md`);
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
    }
    if (fs.existsSync(notePath)) {
      fs.unlinkSync(notePath);
    }
  }

  private renderMemoryNote(item: MemoryItem): string {
    const snapshot = this.toSnapshot(item);
    const related = snapshot.related.map((reference) => `- ${reference.type}:${reference.id}`).join('\n');
    const linked = this.getLinkedMemories(item.id).slice(0, 6).map((memory) => `- [[${memory.id}]] ${memory.content.slice(0, 90)}`).join('\n');
    return [
      '---',
      `id: ${item.id}`,
      `tier: ${item.tier}`,
      `scope: ${item.scope}`,
      `state: ${item.state}`,
      `source: ${item.source}`,
      `priority: ${item.priority}`,
      `relevanceScore: ${snapshot.relevanceScore}`,
      `importanceScore: ${snapshot.importanceScore}`,
      `freshnessScore: ${snapshot.freshnessScore}`,
      `trustScore: ${snapshot.trustScore}`,
      `entropyScore: ${snapshot.entropyScore}`,
      `timestamp: ${new Date(item.timestamp).toISOString()}`,
      item.expiresAt ? `expiresAt: ${new Date(item.expiresAt).toISOString()}` : 'expiresAt:',
      item.supersedes ? `supersedes: ${item.supersedes}` : 'supersedes:',
      item.supersededBy ? `supersededBy: ${item.supersededBy}` : 'supersededBy:',
      `tags: [${item.tags.join(', ')}]`,
      '---',
      '',
      item.content,
      '',
      '## Provenance',
      `- summary: ${item.provenance.summary}`,
      `- source: ${item.provenance.source}`,
      ...(item.provenance.references.length > 0 ? item.provenance.references.map((reference) => `- ref: ${reference}`) : ['- ref: none']),
      '',
      '## Related Runtime Objects',
      related || '- none',
      '',
      '## Backlinks',
      linked || '- none',
      '',
    ].join('\n');
  }

  private projectEntityNotes(items: MemoryItem[]): void {
    const grouped = new Map<string, MemoryItem[]>();
    for (const item of items) {
      for (const reference of this.extractEntityReferences(item)) {
        const key = `${reference.type}:${reference.id}`;
        const existing = grouped.get(key) ?? [];
        existing.push(item);
        grouped.set(key, existing);
      }
    }
    for (const [key, relatedItems] of grouped.entries()) {
      const [entityType, entityId] = key.split(':');
      const targetDir = path.join(this.vaultEntityNotesDir, entityType);
      fs.mkdirSync(targetDir, { recursive: true });
      const body = [
        '---',
        `entityType: ${entityType}`,
        `entityId: ${entityId}`,
        `memoryCount: ${relatedItems.length}`,
        '---',
        '',
        `# ${entityType}:${entityId}`,
        '',
        '## Referencing Memories',
        ...relatedItems
          .sort((left, right) => right.priority - left.priority || right.timestamp - left.timestamp)
          .slice(0, 24)
          .map((item) => `- [[${item.id}]] ${item.content.slice(0, 120)}`),
        '',
      ].join('\n');
      fs.writeFileSync(path.join(targetDir, `${sanitizeFileName(entityId)}.md`), body, 'utf8');
    }
  }

  private projectSessionNotes(items: MemoryItem[]): void {
    const bySession = new Map<string, MemoryItem[]>();
    const byRun = new Map<string, MemoryItem[]>();
    for (const item of items) {
      if (item.sessionId) {
        const sessionItems = bySession.get(item.sessionId) ?? [];
        sessionItems.push(item);
        bySession.set(item.sessionId, sessionItems);
      }
      for (const reference of this.extractEntityReferences(item).filter((entry) => entry.type === 'run')) {
        const runItems = byRun.get(reference.id) ?? [];
        runItems.push(item);
        byRun.set(reference.id, runItems);
      }
    }
    for (const [sessionId, sessionItems] of bySession.entries()) {
      const body = [
        `# Session ${sessionId}`,
        '',
        ...sessionItems
          .sort((left, right) => left.timestamp - right.timestamp)
          .slice(0, 40)
          .map((item) => `- ${new Date(item.timestamp).toISOString()} [[${item.id}]] ${item.content.slice(0, 120)}`),
        '',
      ].join('\n');
      fs.writeFileSync(path.join(this.vaultSessionNotesDir, `${sanitizeFileName(sessionId)}.md`), body, 'utf8');
    }
    for (const [runId, runItems] of byRun.entries()) {
      const body = [
        `# Run ${runId}`,
        '',
        ...runItems
          .sort((left, right) => left.timestamp - right.timestamp)
          .slice(0, 24)
          .map((item) => `- [[${item.id}]] ${item.content.slice(0, 120)}`),
        '',
      ].join('\n');
      fs.writeFileSync(path.join(this.vaultRunNotesDir, `${sanitizeFileName(runId)}.md`), body, 'utf8');
    }
  }

  private parseProvenance(raw: unknown, source: string, sessionId?: string, rawTags?: string): MemoryProvenance {
    try {
      const parsed = typeof raw === 'string' && raw.trim()
        ? JSON.parse(raw)
        : (typeof raw === 'object' && raw ? raw : {});
      return createMemoryProvenance({
        source: (parsed.source ?? source ?? 'runtime') as MemoryProvenance['source'],
        sessionId: parsed.sessionId ?? sessionId,
        runId: parsed.runId,
        workerId: parsed.workerId,
        workspaceId: parsed.workspaceId,
        repoId: parsed.repoId,
        projectId: parsed.projectId,
        lane: parsed.lane,
        containerTags: Array.isArray(parsed.containerTags) ? parsed.containerTags.map(String) : undefined,
        toolName: parsed.toolName,
        references: Array.isArray(parsed.references) ? parsed.references.map(String) : this.extractReferenceIds('', sessionId),
        tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : JSON.parse(rawTags ?? '[]'),
        summary: parsed.summary ?? `${source} memory`,
      });
    } catch {
      return createMemoryProvenance({
        source: (source ?? 'runtime') as MemoryProvenance['source'],
        sessionId,
        lane: this.inferLane(this.parseRawTags(rawTags), source as MemoryItem['source']),
        tags: (() => {
          try {
            return JSON.parse(rawTags ?? '[]');
          } catch {
            return [];
          }
        })(),
        references: this.extractReferenceIds('', sessionId),
        summary: `${source} memory`,
      });
    }
  }

  private extractReferenceIds(content: string, sessionId?: string): string[] {
    const ids = new Set<string>();
    if (sessionId) ids.add(sessionId);
    for (const match of content.match(/\b(?:exec_[a-z0-9_-]+|skill_[a-z0-9_-]+|workflow_[a-z0-9_-]+)\b/gi) ?? []) {
      ids.add(match);
    }
    return [...ids];
  }

  private reconcileCandidate(candidate: MemoryCandidateFact, options: {
    parentId?: string;
    priority: number;
    sessionId?: string;
  }): { action: MemoryReconciliationAction; reason: string; relatedIds: string[] } {
    const related = this.listReconciliationCandidates()
      .filter((item) => item.state !== 'expired')
      .map((item) => ({
        item,
        overlap: this.wordOverlap(
          candidate.content.toLowerCase().split(/\W+/).filter(Boolean),
          item.content.toLowerCase().split(/\W+/).filter(Boolean),
        ),
      }))
      .filter((entry) => entry.overlap >= 0.42)
      .sort((left, right) => right.overlap - left.overlap)
      .slice(0, 4);
    const relatedIds = related.map((entry) => entry.item.id);
    const contradiction = related.some((entry) => /\b(not|never|no longer|cannot|can't)\b/i.test(candidate.content) !== /\b(not|never|no longer|cannot|can't)\b/i.test(entry.item.content));
    if (/delete|remove|obsolete|deprecated|no longer needed|superseded/i.test(candidate.content) && relatedIds.length > 0) {
      return { action: 'DELETE', reason: 'Candidate indicates the prior memory should expire.', relatedIds };
    }
    if (contradiction && relatedIds.length > 0) {
      return { action: 'UPDATE', reason: 'Candidate contradicts an existing memory and should supersede it.', relatedIds };
    }
    if (related.some((entry) => entry.overlap >= 0.9)) {
      return { action: 'NONE', reason: 'Candidate duplicates an existing memory.', relatedIds };
    }
    if (related.some((entry) => entry.overlap >= 0.68)) {
      return { action: 'MERGE', reason: 'Candidate overlaps strongly with an existing memory and should be linked.', relatedIds };
    }
    if (candidate.confidence < 0.52 || options.priority < 0.45) {
      return { action: 'QUARANTINE', reason: 'Candidate has low confidence and should remain quarantined until validated.', relatedIds };
    }
    return { action: 'ADD', reason: 'Candidate is net new and worth storing.', relatedIds };
  }

  private expireMemories(): void {
    this.db.prepare(`
      UPDATE memories
      SET state = 'expired'
      WHERE expires_at IS NOT NULL AND expires_at <= ? AND state != 'expired'
    `).run(Date.now());
  }

  private wordOverlap(a: string[], b: string[]): number {
    const setA = new Set(a.filter(w => w.length > 2));
    const setB = new Set(b.filter(w => w.length > 2));
    if (setA.size === 0 || setB.size === 0) return 0;

    const intersection = [...setA].filter(x => setB.has(x));
    const union = new Set([...setA, ...setB]);
    return intersection.length / union.size;
  }

  private estimateEntropy(words: string[]): number {
    const filtered = words.filter((word) => word.length > 1);
    if (filtered.length === 0) return 1;
    const unique = new Set(filtered);
    const shortNoise = filtered.filter((word) => word.length <= 2).length / filtered.length;
    return Math.min((unique.size / filtered.length) * 0.85 + shortNoise * 0.15, 1);
  }

  private rowToItem(row: any): MemoryItem {
    return {
      id: row.id,
      content: row.content,
      priority: row.priority,
      timestamp: row.timestamp,
      tags: JSON.parse(row.tags ?? '[]'),
      tier: row.tier,
      scope: (row.scope ?? 'session') as MemoryItem['scope'],
      state: (row.state ?? 'active') as MemoryItem['state'],
      source: (row.source ?? 'runtime') as MemoryItem['source'],
      sessionId: row.session_id,
      accessCount: row.access_count,
      parentId: row.parent_id,
      depth: row.depth,
      entropy: row.entropy ?? 0,
      mass: row.mass ?? 1.0,
      trust: row.trust ?? 0.6,
      qmdRecency: row.qmd_recency ?? undefined,
      qmdFrequency: row.qmd_frequency ?? undefined,
      qmdRelevance: row.qmd_relevance ?? undefined,
      expiresAt: row.expires_at ?? undefined,
      supersedes: row.supersedes ?? undefined,
      supersededBy: row.superseded_by ?? undefined,
      provenance: this.parseProvenance(row.provenance_json, row.source ?? 'runtime', row.session_id, row.tags),
    };
  }

  private getById(id: string): MemoryItem | undefined {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;
    return row ? this.rowToItem(row) : undefined;
  }

  private getTotalMemoryCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c?: number } | undefined;
    return row?.c ?? 0;
  }

  private getStateCounts(): Record<string, number> {
    const rows = this.db.prepare(`
      SELECT state, COUNT(*) as c
      FROM memories
      GROUP BY state
    `).all() as Array<{ state: string; c: number }>;
    return rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.state] = row.c;
      return acc;
    }, {});
  }

  private listVaultIndexItems(): Array<{
    id: string;
    tier: MemoryItem['tier'];
    scope: MemoryItem['scope'];
    state: MemoryItem['state'];
    source: MemoryItem['source'];
    priority: number;
    tags: string[];
    trust: number;
  }> {
    const rows = this.db.prepare(`
      SELECT id, tier, scope, state, source, priority, tags, trust
      FROM memories
      ORDER BY priority DESC, timestamp DESC
    `).all() as Array<{
      id: string;
      tier: MemoryItem['tier'];
      scope: MemoryItem['scope'];
      state: MemoryItem['state'];
      source: MemoryItem['source'];
      priority: number;
      tags: string;
      trust: number;
    }>;
    return rows.map((row) => ({
      ...row,
      tags: safeParseTags(row.tags),
    }));
  }

  private listContentCheckCandidates(limit: number = 500): MemoryItem[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM memories
      WHERE state != 'expired'
      ORDER BY priority DESC, timestamp DESC
      LIMIT ?
    `).all(limit) as any[];
    return rows.map((row) => this.rowToItem(row));
  }

  private listReconciliationCandidates(limit: number = 50, entropyLimit: number = 0.88): MemoryItem[] {
    const rows = this.db.prepare(`
      SELECT id, content, tags, tier, scope, state, source, session_id, access_count,
             parent_id, depth, priority, timestamp, entropy, mass, trust,
             qmd_recency, qmd_frequency, qmd_relevance,
             provenance_json, expires_at, supersedes, superseded_by
      FROM memories
      WHERE state != 'scrap' AND entropy < ?
      ORDER BY priority DESC, timestamp DESC
      LIMIT ?
    `).all(entropyLimit, limit) as any[];
    return rows.map((row) => this.rowToItem(row));
  }

  private computeQmdScore(item: MemoryItem): number {
    const now = Date.now();
    const ageDays = (now - item.timestamp) / 86_400_000;
    const recency = item.qmdRecency ?? Math.max(0, 1 - ageDays / 30);
    const frequency = item.qmdFrequency ?? Math.min(1, item.accessCount / 20);
    const relevance = item.qmdRelevance ?? (1 - item.entropy);
    return 0.3 * recency + 0.3 * frequency + 0.2 * relevance + 0.2 * item.trust;
  }

  private getAllItems(): MemoryItem[] {
    const rows = this.db.prepare('SELECT * FROM memories').all() as any[];
    return rows.map(row => this.rowToItem(row));
  }

  private toSnapshot(item: MemoryItem): MemorySnapshot {
    return {
      id: item.id,
      tier: item.tier,
      scope: item.scope,
      state: item.state,
      source: item.source,
      priority: item.priority,
      timestamp: item.timestamp,
      tags: item.tags,
      excerpt: item.content.length > 140 ? `${item.content.slice(0, 137)}...` : item.content,
      parentId: item.parentId,
      depth: item.depth,
      accessCount: item.accessCount,
      linkCount: this.getLinkCount(item.id),
      sessionId: item.sessionId,
      relevanceScore: this.relevanceScore(item),
      importanceScore: this.importanceScore(item),
      freshnessScore: this.freshnessScore(item),
      trustScore: item.trust,
      entropyScore: item.entropy,
      provenance: item.provenance,
      expiresAt: item.expiresAt,
      supersedes: item.supersedes,
      supersededBy: item.supersededBy,
      related: this.extractEntityReferences(item),
    };
  }

  private getLinkCount(id: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as c FROM memory_links WHERE from_id = ? OR to_id = ?
    `).get(id, id) as { c?: number } | undefined;
    return row?.c ?? 0;
  }

  private getLinkedMemories(id: string): MemoryItem[] {
    const rows = this.db.prepare(`
      SELECT m.*
      FROM memory_links l
      JOIN memories m ON m.id = l.to_id
      WHERE l.from_id = ?
      ORDER BY l.weight DESC, m.priority DESC
      LIMIT 12
    `).all(id) as any[];
    return rows.map((row) => this.rowToItem(row));
  }

  private buildLineage(item: MemoryItem): MemorySnapshot[] {
    const lineage: MemorySnapshot[] = [];
    let currentParentId = item.parentId;

    while (currentParentId) {
      const parentRow = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(currentParentId) as any;
      if (!parentRow) break;
      const parentItem = this.rowToItem(parentRow);
      lineage.unshift(this.toSnapshot(parentItem));
      currentParentId = parentItem.parentId;
    }

    lineage.push(this.toSnapshot(item));
    return lineage;
  }

  private buildTimeline(item: MemoryItem): MemorySnapshot[] {
    const lineage = this.buildLineage(item);
    const rootId = lineage[0]?.id ?? item.id;
    const rows = this.db.prepare(`
      WITH RECURSIVE lineage(id, depth) AS (
        SELECT id, 0 FROM memories WHERE id = ?
        UNION ALL
        SELECT m.id, lineage.depth + 1
        FROM memories m
        INNER JOIN lineage ON m.parent_id = lineage.id
        WHERE lineage.depth < 20
      )
      SELECT DISTINCT m.*
      FROM memories m
      LEFT JOIN lineage l ON l.id = m.id
      WHERE l.id IS NOT NULL
         OR m.id = ?
         OR (? IS NOT NULL AND m.session_id = ?)
      ORDER BY m.timestamp ASC
      LIMIT 24
    `).all(rootId, item.id, item.sessionId ?? null, item.sessionId ?? null) as any[];

    return rows.map((row) => this.toSnapshot(this.rowToItem(row)));
  }

  private extractEntityReferences(item: MemoryItem): MemoryEntityReference[] {
    const refs: MemoryEntityReference[] = [];
    const patterns: Array<[MemoryEntityReference['type'], RegExp]> = [
      ['run', /\bexec_[a-z0-9_-]+\b/gi],
      ['skill', /\bskill_[a-z0-9_-]+\b/gi],
      ['workflow', /\bworkflow_[a-z0-9_-]+\b/gi],
    ];

    if (item.sessionId) {
      refs.push({ type: 'session', id: item.sessionId });
    }

    for (const [type, pattern] of patterns) {
      for (const match of item.content.match(pattern) ?? []) {
        refs.push({ type, id: match });
      }
    }

    return dedupeReferences(refs);
  }

  getStats(): MemoryStats {
    const counts = this.db.prepare(`
      SELECT tier, COUNT(*) as c FROM memories GROUP BY tier
      `).all() as any[];

    const tierMap: Record<string, number> = {};
    for (const row of counts) tierMap[row.tier] = row.c;

    const linkCount = (this.db.prepare(
      'SELECT COUNT(*) as c FROM memory_links'
    ).get() as any).c as number;

    const oldest = (this.db.prepare(
      'SELECT MIN(timestamp) as t FROM memories'
    ).get() as any).t as number | null;

    const topTagsRaw = this.db.prepare(`
      SELECT value as tag, COUNT(*) as c
      FROM memories, json_each(memories.tags)
      GROUP BY value ORDER BY c DESC LIMIT 5
      `).all() as any[];

    return {
      prefrontal: tierMap['prefrontal'] ?? 0,
      hippocampus: tierMap['hippocampus'] ?? 0,
      cortex: tierMap['cortex'] ?? 0,
      totalLinks: linkCount,
      oldestEntry: oldest,
      topTags: topTagsRaw.map(r => r.tag as string).filter((tag) => isOperatorVisibleTag(tag)).slice(0, 5)
    };
  }

  snapshot(limit: number = 100): MemoryItem[] {
    const rows = this.db.prepare(`
      SELECT * FROM memories
      ORDER BY priority DESC, timestamp DESC
      LIMIT ?
    `).all(limit) as any[];
    return rows.map(row => this.rowToItem(row));
  }

  listSnapshots(limit: number = 80, filters: {
    tier?: MemoryItem['tier'];
    tag?: string;
    recencyMs?: number;
    linkedType?: MemoryEntityReference['type'];
    scope?: MemoryItem['scope'];
    state?: MemoryItem['state'];
    source?: MemoryItem['source'];
    sessionId?: string;
    repoId?: string;
    workspaceId?: string;
    projectId?: string;
    lane?: MemoryContainerLane;
    includeHidden?: boolean;
  } = {}): MemorySnapshot[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.tier) {
      clauses.push('tier = ?');
      params.push(filters.tier);
    }
    if (filters.scope) {
      clauses.push('scope = ?');
      params.push(filters.scope);
    }
    if (filters.state) {
      clauses.push('state = ?');
      params.push(filters.state);
    }
    if (filters.source) {
      clauses.push('source = ?');
      params.push(filters.source);
    }
    if (filters.sessionId) {
      clauses.push('session_id = ?');
      params.push(filters.sessionId);
    }
    if (filters.recencyMs) {
      clauses.push('timestamp >= ?');
      params.push(Date.now() - filters.recencyMs);
    }
    if (filters.tag) {
      clauses.push('EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value = ?)');
      params.push(filters.tag);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT *
      FROM memories
      ${where}
      ORDER BY priority DESC, timestamp DESC
      LIMIT ?
    `).all(...params, Math.max(limit * 4, limit, 1)) as any[];

    return rows
      .map((row) => this.toSnapshot(this.rowToItem(row)))
      .filter((item) => this.matchesContainerFilters(item.provenance, filters))
      .filter((item) => filters.includeHidden || !this.isHiddenMemory(item.tags))
      .filter((item) => !filters.linkedType || item.related.some((reference) => reference.type === filters.linkedType))
      .sort((a, b) => (b.importanceScore - a.importanceScore) || (b.relevanceScore - a.relevanceScore) || (b.timestamp - a.timestamp))
      .slice(0, Math.max(limit, 1));
  }

  getSnapshot(id: string): MemorySnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return this.toSnapshot(this.rowToItem(row));
  }

  getDetail(id: string): MemoryDetail | undefined {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    const item = this.rowToItem(row);
    const linkedMemories = this.getLinkedMemories(item.id).slice(0, 8).map((linked) => this.toSnapshot(linked));

    return {
      ...this.toSnapshot(item),
      content: item.content,
      lineage: this.buildLineage(item),
      linkedMemories,
      timeline: this.buildTimeline(item),
    };
  }

  getNetworkSnapshot(id?: string, depth: number = 2, limit: number = 18): MemoryNetworkSnapshot {
    const focus = id ? this.getDetail(id) : undefined;
    const baseItems = focus ? [focus, ...focus.linkedMemories] : this.listSnapshots(limit);
    const allItems = this.getAllItems();
    const itemMap = new Map(allItems.map((item) => [item.id, item]));
    const nodes = new Map<string, MemoryNetworkNode>();
    const links: MemoryNetworkLink[] = [];

    const pushMemoryNode = (snapshot: MemorySnapshot) => {
      nodes.set(snapshot.id, {
        id: snapshot.id,
        label: snapshot.excerpt,
        entityType: 'memory',
        tier: snapshot.tier,
        priority: snapshot.priority,
        timestamp: snapshot.timestamp,
      });
    };

    for (const snapshot of baseItems.slice(0, limit)) {
      pushMemoryNode(snapshot);

      if (snapshot.parentId) {
        const parent = itemMap.get(snapshot.parentId);
        if (parent) {
          const parentSnapshot = this.toSnapshot(parent);
          pushMemoryNode(parentSnapshot);
          links.push({
            source: parentSnapshot.id,
            target: snapshot.id,
            type: 'lineage',
            weight: 1,
          });
        }
      }

      const dbLinks = this.db.prepare(`
        SELECT to_id, weight, type FROM memory_links WHERE from_id = ? ORDER BY weight DESC LIMIT ?
      `).all(snapshot.id, depth * 4) as Array<{ to_id: string; weight: number; type: MemoryLink['type'] }>;
      for (const link of dbLinks) {
        const target = itemMap.get(link.to_id);
        if (!target) continue;
        pushMemoryNode(this.toSnapshot(target));
        links.push({
          source: snapshot.id,
          target: target.id,
          type: link.type,
          weight: link.weight,
        });
      }

      for (const reference of snapshot.related) {
        const referenceId = `${reference.type}:${reference.id}`;
        if (!nodes.has(referenceId)) {
          nodes.set(referenceId, {
            id: referenceId,
            label: reference.id,
            entityType: reference.type,
          });
        }
        links.push({
          source: snapshot.id,
          target: referenceId,
          type: 'artifact-derived',
          weight: 0.7,
        });
      }
    }

    return {
      focusId: focus?.id,
      nodes: [...nodes.values()].slice(0, limit * 3),
      links: dedupeLinks(links).slice(0, limit * 6),
    };
  }

  clear(): void {
    this.prefrontal = [];
    this.db.exec('DELETE FROM memory_links; DELETE FROM memories;');
    this.syncVault(true);
  }

  getHealthSummary(): MemoryHealthSummary {
    const counts = this.getStateCounts();
    const promoted = (this.db.prepare(`
      SELECT COUNT(*) as c
      FROM memories
      WHERE scope = 'promoted' OR tier = 'cortex'
    `).get() as { c?: number } | undefined)?.c ?? 0;
    const shared = (this.db.prepare(`
      SELECT COUNT(*) as c
      FROM memories
      WHERE scope = 'shared'
    `).get() as { c?: number } | undefined)?.c ?? 0;
    const topTagsRaw = this.db.prepare(`
      SELECT value as tag, COUNT(*) as c
      FROM memories, json_each(memories.tags)
      GROUP BY value ORDER BY c DESC LIMIT 6
    `).all() as Array<{ tag: string }>;
    return {
      generatedAt: Date.now(),
      total: this.getTotalMemoryCount(),
      active: counts.active ?? 0,
      quarantined: counts.quarantined ?? 0,
      scrap: counts.scrap ?? 0,
      expired: counts.expired ?? 0,
      promoted,
      shared,
      topTags: topTagsRaw.map((entry) => entry.tag).filter((tag) => isOperatorVisibleTag(tag)).slice(0, 6),
    };
  }

  getScopeUsageSummary(sessionId?: string): {
    generatedAt: number;
    byScope: Record<string, number>;
    byState: Record<string, number>;
    sharedContextCount: number;
  } {
    const visibilityClause = sessionId ? 'WHERE session_id = ? OR scope != ?' : '';
    const visibilityParams = sessionId ? [sessionId, 'session'] : [];
    const byScopeRows = this.db.prepare(`
      SELECT scope, COUNT(*) as c
      FROM memories
      ${visibilityClause}
      GROUP BY scope
    `).all(...visibilityParams) as Array<{ scope: string; c: number }>;
    const byStateRows = this.db.prepare(`
      SELECT state, COUNT(*) as c
      FROM memories
      ${visibilityClause}
      GROUP BY state
    `).all(...visibilityParams) as Array<{ state: string; c: number }>;
    const sharedContextCount = (this.db.prepare(`
      SELECT COUNT(*) as c
      FROM memories
      WHERE scope = 'shared'
        AND state = 'active'
        ${sessionId ? 'AND (session_id = ? OR scope != ?)' : ''}
    `).get(...visibilityParams) as { c?: number } | undefined)?.c ?? 0;
    const byScope = byScopeRows.reduce<Record<string, number>>((acc, row) => {
      acc[row.scope] = row.c;
      return acc;
    }, {});
    const byState = byStateRows.reduce<Record<string, number>>((acc, row) => {
      acc[row.state] = row.c;
      return acc;
    }, {});

    return {
      generatedAt: Date.now(),
      byScope,
      byState,
      sharedContextCount,
    };
  }

  getContainerSummary(sessionId?: string): MemoryContainerSummary {
    const snapshots = this.listSnapshots(500, { sessionId, includeHidden: true });
    const byLane: Record<MemoryContainerLane, number> = {
      profile: 0,
      workspace: 0,
      shared: 0,
      inbox: 0,
    };
    const byRepoId: Record<string, number> = {};
    const byProjectId: Record<string, number> = {};
    const byWorkspaceId: Record<string, number> = {};
    let hiddenCount = 0;

    for (const snapshot of snapshots) {
      const lane = snapshot.provenance.lane ?? this.inferLane(snapshot.tags, snapshot.source);
      byLane[lane] += 1;
      if (snapshot.provenance.repoId) {
        byRepoId[snapshot.provenance.repoId] = (byRepoId[snapshot.provenance.repoId] || 0) + 1;
      }
      if (snapshot.provenance.projectId) {
        byProjectId[snapshot.provenance.projectId] = (byProjectId[snapshot.provenance.projectId] || 0) + 1;
      }
      if (snapshot.provenance.workspaceId) {
        byWorkspaceId[snapshot.provenance.workspaceId] = (byWorkspaceId[snapshot.provenance.workspaceId] || 0) + 1;
      }
      if (this.isHiddenMemory(snapshot.tags)) hiddenCount += 1;
    }

    return {
      generatedAt: Date.now(),
      byLane,
      byRepoId,
      byProjectId,
      byWorkspaceId,
      hiddenCount,
    };
  }

  getLastPreCompactionBackup(): MemoryBackupSnapshot | null {
    return this.lastPreCompactionBackup;
  }

  listSharedSnapshots(limit: number = 24, sessionId?: string): MemorySnapshot[] {
    return this.listSnapshots(limit, {
      scope: 'shared',
      state: 'active',
      sessionId,
    });
  }

  exportBundle(options: {
    limit?: number;
    scope?: MemoryItem['scope'];
    state?: MemoryItem['state'];
    sessionId?: string;
  } = {}): MemoryExportBundle {
    const items = this.getAllItems()
      .filter((item) => !options.scope || item.scope === options.scope)
      .filter((item) => !options.state || item.state === options.state)
      .filter((item) => !options.sessionId || item.sessionId === options.sessionId)
      .sort((a, b) => (b.priority - a.priority) || (b.timestamp - a.timestamp))
      .slice(0, Math.max(options.limit ?? 500, 1))
      .map((item) => ({
        id: item.id,
        content: item.content,
        priority: item.priority,
        timestamp: item.timestamp,
        tags: item.tags,
        tier: item.tier,
        scope: item.scope,
        state: item.state,
        source: item.source,
        sessionId: item.sessionId,
        accessCount: item.accessCount,
        parentId: item.parentId,
        depth: item.depth,
        entropy: item.entropy,
        mass: item.mass,
        trust: item.trust,
        expiresAt: item.expiresAt,
        supersedes: item.supersedes,
        supersededBy: item.supersededBy,
        provenance: item.provenance,
      }));
    return {
      version: 1,
      exportedAt: Date.now(),
      sessionId: this.sessionId,
      stats: this.getStats(),
      health: this.getHealthSummary(),
      items,
    };
  }

  backupBundle(options: {
    limit?: number;
    scope?: MemoryItem['scope'];
    state?: MemoryItem['state'];
    sessionId?: string;
  } = {}): { path: string; bundle: MemoryExportBundle } {
    const bundle = this.exportBundle(options);
    const filePath = path.join(this.vaultExportsDir, `memory-backup-${bundle.exportedAt}.json`);
    fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), 'utf8');
    return { path: filePath, bundle };
  }

  importBundle(input: { path?: string; bundle?: MemoryExportBundle }): {
    imported: number;
    duplicates: number;
    quarantined: number;
    importedIds: string[];
  } {
    const bundle = input.bundle ?? (input.path
      ? JSON.parse(fs.readFileSync(path.resolve(input.path), 'utf8')) as MemoryExportBundle
      : undefined);
    if (!bundle) {
      return { imported: 0, duplicates: 0, quarantined: 0, importedIds: [] };
    }
    let imported = 0;
    let duplicates = 0;
    let quarantined = 0;
    const importedIds: string[] = [];
    for (const item of bundle.items) {
      const check = this.checkContent(item.content, {
        tags: item.tags,
        priority: item.priority,
        parentId: item.parentId,
      });
      if (check.duplicateCluster.length > 0) {
        duplicates += 1;
        continue;
      }
      const tags = dedupeStrings([
        ...item.tags,
        '#imported',
        item.scope === 'shared' ? '#shared' : '',
        item.scope === 'project' ? '#project' : '',
        item.scope === 'user' ? '#user' : '',
        item.scope === 'promoted' ? '#promoted' : '',
        (item.state === 'quarantined' || check.action === 'quarantine' || check.action === 'block') ? '#quarantine' : '',
      ].filter(Boolean));
      const id = this.store(item.content, item.priority, tags, item.parentId, item.depth ?? 0, {
        sessionId: item.sessionId,
        timestamp: item.timestamp,
        scope: item.scope,
        state: item.state === 'quarantined' || check.action === 'quarantine' || check.action === 'block'
          ? 'quarantined'
          : item.state,
        source: 'imported',
        trust: item.trust,
        expiresAt: item.expiresAt,
        supersedes: item.supersedes,
        supersededBy: item.supersededBy,
        provenance: item.provenance,
      });
      imported += 1;
      if (tags.includes('#quarantine')) quarantined += 1;
      importedIds.push(id);
    }
    this.syncVault(true);
    return { imported, duplicates, quarantined, importedIds };
  }

  /**
   * Query memories by tag using direct SQL — precise, no fuzzy matching.
   * Returns memories that contain ANY of the specified tags.
   */
  queryByTags(tags: string[], limit: number = 20): MemoryItem[] {
    if (tags.length === 0) return [];
    const placeholders = tags.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT DISTINCT m.* FROM memories m, json_each(m.tags) jt
      WHERE jt.value IN (${placeholders})
      ORDER BY m.priority DESC, m.timestamp DESC
      LIMIT ?
    `).all(...tags, limit) as any[];
    return rows.map(row => this.rowToItem(row));
  }

  close(): void {
    this.flush();
    this.flushVaultSync();
    this.db.close();
    this.graphMirror?.close();
  }

  private mirrorIntoGraph(item: Pick<MemoryItem, 'content' | 'priority' | 'tags'>): void {
    if (!this.graphMirror) return;
    try {
      this.graphMirror.store(item.content, item.priority, item.tags);
    } catch (err) {
      nexusEventBus.emit('graph.sync.failed', {
        reason: String(err),
        ts: Date.now(),
      });
      this.graphMirror = undefined;
    }
  }

  private primeGraphMirror(rows: Array<{ content: string; priority: number; tags: string }> = [], force: boolean = false): void {
    if (!this.graphMirror || rows.length === 0) return;
    try {
      const stats = this.graphMirror.getGraphStats();
      if (!force && (stats.entities > 0 || stats.facts > 0)) {
        return;
      }
      rows.forEach((row) => {
        this.graphMirror?.store(
          String(row.content ?? ''),
          Number(row.priority ?? 0.7),
          safeParseTags(row.tags),
        );
      });
    } catch (err) {
      nexusEventBus.emit('graph.sync.failed', {
        reason: String(err),
        ts: Date.now(),
      });
      this.graphMirror = undefined;
    }
  }

  private checkGraphCoverage(): void {
    if (!this.graphMirror) return;
    const memCount = this.getTotalMemoryCount();
    if (memCount === 0) return;
    const stats = this.graphMirror.getGraphStats();
    if (stats.entities < memCount * 0.5) {
      nexusEventBus.emit('graph.coverage.low', {
        memCount,
        graphEntities: stats.entities,
      });
      const rows = this.db.prepare(`
        SELECT content, priority, tags
        FROM memories
        ORDER BY priority DESC, timestamp DESC
        LIMIT 500
      `).all() as Array<{ content: string; priority: number; tags: string }>;
      this.primeGraphMirror(rows, true);
    }
  }

  private rebuildPersistentVocabularyStatsIfNeeded(): void {
    const docCountRow = this.db.prepare(
      `SELECT value FROM vocabulary_meta WHERE key = 'doc_count'`
    ).get() as { value?: string } | undefined;
    const statsRow = this.db.prepare('SELECT COUNT(*) as c FROM vocabulary_stats').get() as { c?: number } | undefined;
    if ((docCountRow?.value ?? '0') !== '0' || (statsRow?.c ?? 0) > 0) {
      return;
    }

    const rows = this.db.prepare('SELECT content FROM memories ORDER BY timestamp ASC').all() as Array<{ content: string }>;
    if (rows.length === 0) {
      return;
    }

    this.embedder.fitVocabulary(rows.map((row) => row.content));
  }
}

export const createMemoryEngine = (dbPath?: string) => new MemoryEngine(dbPath);

function safeParseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isOperatorVisibleTag(tag: string): boolean {
  return !['#phantom-learning', '#swarm', '#repo-profile', '#hidden', '#system-hidden', '#system'].includes(tag);
}

function dedupeReferences(references: MemoryEntityReference[]): MemoryEntityReference[] {
  const seen = new Set<string>();
  const result: MemoryEntityReference[] = [];
  for (const reference of references) {
    const key = `${reference.type}:${reference.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(reference);
  }
  return result;
}

function dedupeLinks(links: MemoryNetworkLink[]): MemoryNetworkLink[] {
  const seen = new Set<string>();
  const result: MemoryNetworkLink[] = [];
  for (const link of links) {
    const key = `${link.source}:${link.target}:${link.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(link);
  }
  return result;
}

function sanitizeFileName(value: string): string {
  return value
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'memory';
}
