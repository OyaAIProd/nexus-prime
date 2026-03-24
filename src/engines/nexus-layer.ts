import type { OrchestratorEngine } from './orchestrator.js';
import type { MemoryEngine } from './memory.js';
import type { SubAgentRuntime } from '../phantom/runtime.js';

export type NexusLayerDomain = 'knowledge' | 'reflection' | 'workspace';

export interface NexusLayerDomainSummary {
  domain: NexusLayerDomain;
  headline: string;
  counts: Record<string, number>;
  topTags: string[];
  notes: string[];
}

export interface NexusLayerSummary {
  generatedAt: number;
  compatibility: {
    importExport: 'bundle';
    readModels: 'dashboard-summary-surface-entity';
    search: 'snapshot-trace';
    localFirst: true;
  };
  domains: Record<NexusLayerDomain, NexusLayerDomainSummary>;
}

export class NexusLayerAdapter {
  constructor(
    private readonly memory: MemoryEngine,
    private readonly runtime?: SubAgentRuntime,
    private readonly orchestrator?: OrchestratorEngine,
  ) {}

  getSummary(sessionId?: string): NexusLayerSummary {
    const health = this.runtime?.getMemoryHealth?.() ?? this.memory.getHealthSummary();
    const scopeUsage = this.runtime?.getMemoryScopeUsage?.() ?? this.memory.getScopeUsageSummary(sessionId);
    const containerSummary = this.memory.getContainerSummary(sessionId);
    const reconciliation = this.runtime?.getMemoryReconciliationSummary?.() ?? this.memory.getLastReconciliationSummary();
    const collections = this.orchestrator?.listRagCollections?.() ?? [];
    const runs = this.runtime?.listRuns?.(8) ?? [];
    const lastBackup = this.memory.getLastPreCompactionBackup();

    return {
      generatedAt: Date.now(),
      compatibility: {
        importExport: 'bundle',
        readModels: 'dashboard-summary-surface-entity',
        search: 'snapshot-trace',
        localFirst: true,
      },
      domains: {
        knowledge: {
          domain: 'knowledge',
          headline: 'Promoted, shared, and attached context that can travel across runs and clients.',
          counts: {
            promoted: Number(health.promoted || 0),
            shared: Number(containerSummary.byLane.shared || 0),
            profile: Number(containerSummary.byLane.profile || 0),
            collections: collections.length,
          },
          topTags: Array.isArray(health.topTags) ? health.topTags.slice(0, 6) : [],
          notes: [
            collections.length
              ? `${collections.length} attached RAG collection${collections.length === 1 ? '' : 's'} ready for reuse.`
              : 'No attached RAG collections yet.',
            'Designed to stay local-first while keeping import/export compatibility via memory bundles.',
          ],
        },
        reflection: {
          domain: 'reflection',
          headline: 'Reconciliation, quarantine, and review signals that explain why memory changed.',
          counts: {
            quarantined: Number(health.quarantined || 0),
            inbox: Number(containerSummary.byLane.inbox || 0),
            reconciliationEntries: Array.isArray(reconciliation.entries) ? reconciliation.entries.length : 0,
            reviewActions: Object.values(reconciliation.actionCounts || {}).reduce((sum, value) => sum + Number(value || 0), 0),
          },
          topTags: Array.isArray(health.topTags) ? health.topTags.slice(0, 4) : [],
          notes: [
            reconciliation.entries?.[0]?.reason || 'No recent reconciliation action recorded.',
            lastBackup ? `Last pre-compaction backup: ${lastBackup.path}` : 'No pre-compaction backup recorded yet.',
            'Reflection keeps provenance and trust checks visible without changing existing MCP memory tools.',
          ],
        },
        workspace: {
          domain: 'workspace',
          headline: 'Session, project, and run-local context that powers the current operator loop.',
          counts: {
            session: Number(scopeUsage.byScope?.session || 0),
            project: Number(scopeUsage.byScope?.project || 0),
            user: Number(scopeUsage.byScope?.user || 0),
            workspace: Number(containerSummary.byLane.workspace || 0),
            runs: runs.length,
          },
          topTags: Array.isArray(health.topTags) ? health.topTags.slice(0, 4) : [],
          notes: [
            `Shared active context: ${Number(scopeUsage.sharedContextCount || 0)}.`,
            runs[0]?.goal ? `Latest run: ${runs[0].goal}` : 'No recent run has been recorded yet.',
          ],
        },
      },
    };
  }

  exportBundle(options: Parameters<MemoryEngine['exportBundle']>[0] = {}) {
    return this.memory.exportBundle(options);
  }

  importBundle(input: Parameters<MemoryEngine['importBundle']>[0]) {
    return this.memory.importBundle(input);
  }

  listSnapshots(limit = 24, filters: Parameters<MemoryEngine['listSnapshots']>[1] = {}) {
    return this.memory.listSnapshots(limit, filters);
  }

  trace(id: string) {
    return this.memory.trace(id);
  }
}
