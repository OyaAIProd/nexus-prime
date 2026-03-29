/**
 * Dynamic Context Discovery Engine
 *
 * Inspired by Cursor's lazy context loading approach.
 * Instead of shipping all MCP tool descriptions to every request,
 * this engine provides minimal summaries and expands on demand.
 *
 * Reduces context tokens by ~40-50% for tool descriptions alone.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolSummary {
  name: string;
  /** 1-line summary (10-15 words max) */
  summary: string;
  /** Full description (loaded on demand) */
  fullDescription: string;
  /** Keywords for task matching */
  keywords: string[];
}

export interface ResolvedContext {
  /** Tools with full descriptions (task-relevant) */
  expanded: string[];
  /** Tools with summary only (not immediately relevant) */
  summarized: string[];
  /** Estimated tokens saved */
  tokensSaved: number;
  /** Original token count if all tools had full descriptions */
  originalTokens: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Max tools to expand with full descriptions per request */
const MAX_EXPANDED_TOOLS = 8;

/** Core lifecycle tools that should stay expanded even before a task is known */
const DEFAULT_EXPANDED_TOOLS = new Set([
  'nexus_session_bootstrap',
  'nexus_orchestrate',
  'nexus_plan_execution',
  'nexus_optimize_tokens',
  'nexus_mindkit_check',
  'nexus_store_memory',
  'nexus_session_dna',
  'nexus_ghost_pass',
  'nexus_search',
  'nexus_describe_tool',
]);

/** Keywords that signal tool relevance to a task */
const TOOL_KEYWORD_MAP: Record<string, string[]> = {
  nexus_session_bootstrap: ['start', 'begin', 'session', 'initialize', 'bootstrap', 'setup'],
  nexus_orchestrate: ['run', 'execute', 'orchestrate', 'plan', 'build', 'implement', 'create', 'fix', 'refactor'],
  nexus_plan_execution: ['plan', 'design', 'architecture', 'phases', 'steps'],
  nexus_recall_memory: ['remember', 'recall', 'memory', 'previous', 'history', 'context', 'what did'],
  nexus_store_memory: ['save', 'store', 'remember', 'persist', 'note'],
  nexus_memory_stats: ['memory', 'stats', 'statistics', 'count', 'usage', 'health'],
  nexus_optimize_tokens: ['token', 'optimize', 'save', 'reduce', 'efficient', 'budget', 'cost'],
  nexus_search: ['search', 'find', 'grep', 'locate', 'look for', 'where is', 'pattern'],
  nexus_mindkit_check: ['guard', 'safety', 'check', 'validate', 'destructive', 'delete', 'remove'],
  nexus_ghost_pass: ['review', 'ghost', 'pass', 'audit', 'security', 'risk'],
  nexus_spawn_workers: ['worker', 'parallel', 'spawn', 'concurrent', 'multi'],
  nexus_token_report: ['token', 'report', 'savings', 'analytics', 'cost', 'usage'],
  nexus_session_dna: ['session', 'dna', 'handover', 'context', 'continuity'],
  nexus_list_skills: ['skill', 'list', 'available', 'capabilities'],
  nexus_list_workflows: ['workflow', 'list', 'automation', 'pipeline'],
  nexus_list_hooks: ['hook', 'trigger', 'event', 'lifecycle'],
  nexus_list_automations: ['automation', 'auto', 'scheduled'],
  nexus_list_specialists: ['specialist', 'expert', 'domain'],
  nexus_list_crews: ['crew', 'team', 'group'],
  nexus_federation_status: ['federation', 'network', 'distributed', 'pod'],
  nexus_run_status: ['run', 'status', 'progress', 'execution', 'result'],
};

// ─────────────────────────────────────────────────────────────────────────────
// DynamicContextDiscovery
// ─────────────────────────────────────────────────────────────────────────────

export class DynamicContextDiscovery {
  private toolSummaries: Map<string, ToolSummary> = new Map();
  private contextTokensBefore = 0;
  private contextTokensAfter = 0;

  /**
   * Register tools and generate 1-line summaries for lazy loading.
   */
  registerTools(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      const summary = this.generateSummary(tool);
      this.toolSummaries.set(tool.name, {
        name: tool.name,
        summary,
        fullDescription: tool.description,
        keywords: TOOL_KEYWORD_MAP[tool.name] ?? this.extractKeywords(tool.description),
      });
    }
  }

  /**
   * Resolve which tools should get full descriptions based on the current task.
   * Returns tools split into expanded (full desc) and summarized (1-line).
   */
  resolveContext(task: string, tools: ToolDefinition[]): ResolvedContext {
    if (tools.length === 0) {
      return { expanded: [], summarized: [], tokensSaved: 0, originalTokens: 0 };
    }

    if (!task.trim()) {
      const expanded = tools
        .filter((tool) => DEFAULT_EXPANDED_TOOLS.has(tool.name))
        .map((tool) => tool.name);
      const expandedSet = new Set(expanded);
      const summarized = tools
        .filter((tool) => !expandedSet.has(tool.name))
        .map((tool) => tool.name);
      const originalTokens = tools.reduce((sum, tool) => sum + Math.ceil(tool.description.length / 4), 0);
      const expandedTokens = tools
        .filter((tool) => expandedSet.has(tool.name))
        .reduce((sum, tool) => sum + Math.ceil(tool.description.length / 4), 0);
      const summarizedTokens = summarized.length * 10;
      const afterTokens = expandedTokens + summarizedTokens;
      const tokensSaved = Math.max(0, originalTokens - afterTokens);

      this.contextTokensBefore = originalTokens;
      this.contextTokensAfter = afterTokens;
      return { expanded, summarized, tokensSaved, originalTokens };
    }

    const taskLower = task.toLowerCase();
    const taskWords = new Set(taskLower.split(/\s+/).filter(w => w.length > 2));

    // Score each tool by relevance to the task
    const scored: Array<{ name: string; score: number }> = [];

    for (const tool of tools) {
      const toolMeta = this.toolSummaries.get(tool.name);
      const keywords = toolMeta?.keywords ?? this.extractKeywords(tool.description);

      let score = 0;
      for (const keyword of keywords) {
        if (taskLower.includes(keyword)) score += 2;
        if (taskWords.has(keyword)) score += 1;
      }

      // Boost always-needed tools
      if (tool.name === 'nexus_session_bootstrap' || tool.name === 'nexus_orchestrate') {
        score += 5;
      }

      scored.push({ name: tool.name, score });
    }

    // Sort by relevance, take top N for full expansion
    scored.sort((a, b) => b.score - a.score);
    const expanded = scored.slice(0, MAX_EXPANDED_TOOLS).map(s => s.name);
    const summarized = scored.slice(MAX_EXPANDED_TOOLS).map(s => s.name);

    // Calculate token savings
    const originalTokens = tools.reduce((sum, t) => sum + Math.ceil(t.description.length / 4), 0);
    const expandedTokens = tools
      .filter(t => expanded.includes(t.name))
      .reduce((sum, t) => sum + Math.ceil(t.description.length / 4), 0);
    const summarizedTokens = summarized.length * 10; // ~10 tokens per 1-line summary
    const afterTokens = expandedTokens + summarizedTokens;
    const tokensSaved = Math.max(0, originalTokens - afterTokens);

    this.contextTokensBefore = originalTokens;
    this.contextTokensAfter = afterTokens;

    return { expanded, summarized, tokensSaved, originalTokens };
  }

  /**
   * Apply dynamic context to a tool list: expand relevant tools, summarize others.
   */
  applyToTools(task: string, tools: ToolDefinition[]): ToolDefinition[] {
    const resolved = this.resolveContext(task, tools);
    const expandedSet = new Set(resolved.expanded);

    return tools.map(tool => {
      if (expandedSet.has(tool.name)) {
        return tool; // Full description
      }
      // Replace with 1-line summary
      const meta = this.toolSummaries.get(tool.name);
      return {
        ...tool,
        description: meta?.summary ?? this.generateSummary(tool),
      };
    });
  }

  /**
   * Get full description for a specific tool (pull-on-demand).
   */
  getFullDescription(toolName: string): string | null {
    const meta = this.toolSummaries.get(toolName);
    return meta?.fullDescription ?? null;
  }

  /**
   * Get context savings metrics.
   */
  getContextMetrics(): { tokensBefore: number; tokensAfter: number; savings: number; pct: number } {
    const savings = Math.max(0, this.contextTokensBefore - this.contextTokensAfter);
    const pct = this.contextTokensBefore > 0
      ? Math.round(savings / this.contextTokensBefore * 100)
      : 0;
    return {
      tokensBefore: this.contextTokensBefore,
      tokensAfter: this.contextTokensAfter,
      savings,
      pct,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private generateSummary(tool: ToolDefinition): string {
    // Extract first sentence, cap at ~80 chars
    const firstSentence = tool.description.split(/\.\s/)[0];
    if (firstSentence.length <= 80) return firstSentence + '.';
    return firstSentence.slice(0, 77) + '...';
  }

  private extractKeywords(description: string): string[] {
    const stopwords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'up', 'about', 'into', 'through',
      'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
      'this', 'that', 'these', 'those', 'it', 'its', 'use', 'when', 'before',
    ]);
    return description
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 3 && !stopwords.has(w))
      .slice(0, 8);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let _sharedDiscovery: DynamicContextDiscovery | null = null;

export function getSharedContextDiscovery(): DynamicContextDiscovery {
  if (!_sharedDiscovery) {
    _sharedDiscovery = new DynamicContextDiscovery();
  }
  return _sharedDiscovery;
}
