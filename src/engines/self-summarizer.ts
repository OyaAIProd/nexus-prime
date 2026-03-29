/**
 * Self-Summarization Engine
 *
 * LLM-based context compression inspired by Cursor's self-summarization approach.
 * At configurable token thresholds, generates ~1000 token semantic summaries
 * preserving task state, key decisions, and file context.
 *
 * Summaries are stored in Nexus memory and reused on subsequent sessions
 * to dramatically reduce token consumption on repeat project visits.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SelfSummary {
  /** Semantic summary (~1000 tokens) */
  summary: string;
  /** Current task/plan state */
  taskState: string;
  /** Key decisions preserved for continuity */
  keyDecisions: string[];
  /** File fingerprints: path → sha256 hash (for change detection) */
  fileFingerprints: Record<string, string>;
  /** Number of times this session has been summarized */
  priorSummaryCount: number;
  /** When the summary was generated */
  timestamp: number;
  /** Project scope identifier */
  projectId: string;
  /** Token count of the summary itself */
  summaryTokens: number;
  /** Original context tokens that were compressed */
  originalTokens: number;
}

export interface SummarizationContext {
  /** Recent conversation/action history */
  conversationHistory: string[];
  /** Currently active file paths */
  activeFiles: string[];
  /** Current task description or plan state */
  taskState: string;
  /** How many prior summarizations have occurred */
  priorSummaryCount: number;
  /** Estimated current token count */
  currentTokenCount: number;
}

export interface SelfSummarizerOptions {
  /** Token count threshold to trigger summarization (default: 40000) */
  tokenThreshold?: number;
  /** Max tokens for the summary output (default: 1000) */
  summaryBudget?: number;
  /** Project identifier for scoped storage */
  projectId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TOKEN_THRESHOLD = Number(process.env.NEXUS_SUMMARY_THRESHOLD) || 40_000;
const DEFAULT_SUMMARY_BUDGET = Number(process.env.NEXUS_SUMMARY_BUDGET) || 1000;
const NEXUS_STATE_DIR = path.join(os.homedir(), '.nexus-prime');
const SUMMARIES_DIR = path.join(NEXUS_STATE_DIR, 'summaries');

// ─────────────────────────────────────────────────────────────────────────────
// Summarization prompt
// ─────────────────────────────────────────────────────────────────────────────

function buildSummarizationPrompt(context: SummarizationContext): string {
  const historyBlock = context.conversationHistory.slice(-20).join('\n---\n');
  const filesBlock = context.activeFiles.slice(0, 30).join('\n');

  return `You are summarizing a coding session context. Generate a concise summary in approximately ${DEFAULT_SUMMARY_BUDGET} tokens.

PRESERVE (critical for session continuity):
1. Current task and plan state — what's being worked on and what step we're at
2. Key decisions made and their rationale — why choices were made
3. File modifications and their purpose — what changed and why
4. Remaining tasks — what still needs to be done
5. Any errors encountered and their resolution status

DO NOT include:
- Raw file contents or code blocks
- Verbose explanations — be terse and information-dense
- Implementation details that can be re-read from files

Current task state: ${context.taskState}

Active files:
${filesBlock}

Recent session history:
${historyBlock}

Prior summarizations: ${context.priorSummaryCount}

Generate a summary that would let a future session continue this work without re-reading unchanged files:`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SelfSummarizer
// ─────────────────────────────────────────────────────────────────────────────

export class SelfSummarizer {
  private tokenThreshold: number;
  private summaryBudget: number;
  private projectId: string;
  private summaryCount = 0;

  constructor(options?: SelfSummarizerOptions) {
    this.tokenThreshold = options?.tokenThreshold ?? DEFAULT_TOKEN_THRESHOLD;
    this.summaryBudget = options?.summaryBudget ?? DEFAULT_SUMMARY_BUDGET;
    this.projectId = options?.projectId ?? 'default';
    this.ensureSummariesDir();
  }

  // ── Trigger check ────────────────────────────────────────────────────────

  /**
   * Check if summarization should trigger based on current token count.
   */
  shouldSummarize(currentTokenCount: number): boolean {
    return currentTokenCount >= this.tokenThreshold;
  }

  // ── Summarize ────────────────────────────────────────────────────────────

  /**
   * Generate a self-summary from current session context.
   * Uses a local heuristic-based approach (no LLM call required) that
   * extracts key information from the conversation history.
   *
   * For LLM-based summarization, the caller should pass the prompt from
   * buildSummarizationPrompt() to their preferred LLM endpoint.
   */
  summarize(context: SummarizationContext): SelfSummary {
    this.summaryCount++;

    // Heuristic extraction: pull key signals from conversation history
    const keyDecisions: string[] = [];
    const actionItems: string[] = [];

    for (const entry of context.conversationHistory) {
      // Extract decisions (lines with decision-like patterns)
      const decisionPatterns = /(?:decided|chose|selected|using|switched to|going with|will use|picked)\s+(.{10,80})/gi;
      let match;
      while ((match = decisionPatterns.exec(entry)) !== null) {
        keyDecisions.push(match[0].trim());
      }
      // Extract remaining tasks
      const todoPatterns = /(?:TODO|FIXME|still need|remaining|next step|then we need)\s*:?\s*(.{10,80})/gi;
      while ((match = todoPatterns.exec(entry)) !== null) {
        actionItems.push(match[0].trim());
      }
    }

    // Build compact summary
    const summaryParts = [
      `## Session Summary (auto-generated, summarization #${this.summaryCount})`,
      `**Task:** ${context.taskState}`,
      `**Active files:** ${context.activeFiles.length} files`,
      context.activeFiles.slice(0, 10).map(f => `  - ${path.basename(f)}`).join('\n'),
    ];

    if (keyDecisions.length > 0) {
      summaryParts.push(`**Key decisions:**`);
      summaryParts.push(...keyDecisions.slice(0, 8).map(d => `  - ${d}`));
    }

    if (actionItems.length > 0) {
      summaryParts.push(`**Remaining:**`);
      summaryParts.push(...actionItems.slice(0, 5).map(a => `  - ${a}`));
    }

    summaryParts.push(`**Compression:** ${context.currentTokenCount.toLocaleString()} tokens → ~${this.summaryBudget} tokens`);

    const summary = summaryParts.join('\n');
    const summaryTokens = Math.ceil(summary.length / 4);

    const result: SelfSummary = {
      summary,
      taskState: context.taskState,
      keyDecisions: keyDecisions.slice(0, 8),
      fileFingerprints: {},
      priorSummaryCount: this.summaryCount,
      timestamp: Date.now(),
      projectId: this.projectId,
      summaryTokens,
      originalTokens: context.currentTokenCount,
    };

    // Persist locally
    this.persistSummary(result);

    return result;
  }

  /**
   * Get the LLM prompt for external summarization.
   * The caller should send this to Anthropic API and store the result.
   */
  getSummarizationPrompt(context: SummarizationContext): string {
    return buildSummarizationPrompt(context);
  }

  // ── Bootstrap from prior summary ─────────────────────────────────────────

  /**
   * Attempt to bootstrap from a previously stored summary for this project.
   * Returns null if no summary exists or it's too old.
   */
  bootstrapFromSummary(projectId?: string): SelfSummary | null {
    const pid = projectId ?? this.projectId;
    const summaryPath = path.join(SUMMARIES_DIR, `${sanitizeId(pid)}-latest.json`);

    try {
      if (!fs.existsSync(summaryPath)) return null;
      const data = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as SelfSummary;

      // Check staleness: summaries older than 7 days are too stale
      const ageMs = Date.now() - data.timestamp;
      const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
      if (ageMs > maxAgeMs) return null;

      return data;
    } catch {
      return null;
    }
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private persistSummary(summary: SelfSummary): void {
    try {
      const filename = `${sanitizeId(summary.projectId)}-latest.json`;
      fs.writeFileSync(
        path.join(SUMMARIES_DIR, filename),
        JSON.stringify(summary, null, 2),
        'utf8'
      );
    } catch { /* best effort */ }
  }

  private ensureSummariesDir(): void {
    try {
      if (!fs.existsSync(SUMMARIES_DIR)) {
        fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
      }
    } catch { /* best effort */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

const _sharedSummarizers = new Map<string, SelfSummarizer>();

export function getSharedSummarizer(options?: SelfSummarizerOptions): SelfSummarizer {
  const projectId = options?.projectId ?? 'default';
  const existing = _sharedSummarizers.get(projectId);
  if (existing) {
    return existing;
  }
  const summarizer = new SelfSummarizer(options);
  _sharedSummarizers.set(projectId, summarizer);
  return summarizer;
}
