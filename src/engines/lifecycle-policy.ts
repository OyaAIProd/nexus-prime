import { createHash } from 'crypto';

export type LifecycleFeature =
  | 'autoTokenBootstrap'
  | 'memoryInjection'
  | 'autoGhostPass'
  | 'eventThrottle'
  | 'eventNoiseFilter'
  | 'crossProjectMemory'
  | 'mcpCategoryVisuals';

export interface LifecyclePolicyDecision {
  feature: LifecycleFeature;
  enabled: boolean;
  failOpen: boolean;
  reason: string;
  timestamp: number;
  contextHash: string;
}

interface LifecyclePolicyMetrics {
  total: number;
  enabled: number;
  disabled: number;
  lastDecision?: LifecyclePolicyDecision;
}

const DEFAULT_FLAGS: Record<LifecycleFeature, boolean> = {
  autoTokenBootstrap: true,
  memoryInjection: true,
  autoGhostPass: true,
  eventThrottle: true,
  eventNoiseFilter: true,
  crossProjectMemory: true,
  mcpCategoryVisuals: true,
};

const FLAG_ENV_KEYS: Record<LifecycleFeature, string> = {
  autoTokenBootstrap: 'NEXUS_FEATURE_AUTO_TOKEN_BOOTSTRAP',
  memoryInjection: 'NEXUS_FEATURE_MEMORY_INJECTION',
  autoGhostPass: 'NEXUS_FEATURE_AUTO_GHOST_PASS',
  eventThrottle: 'NEXUS_FEATURE_EVENT_THROTTLE',
  eventNoiseFilter: 'NEXUS_FEATURE_EVENT_NOISE_FILTER',
  crossProjectMemory: 'NEXUS_FEATURE_CROSS_PROJECT_MEMORY',
  mcpCategoryVisuals: 'NEXUS_FEATURE_MCP_CATEGORY_VISUALS',
};

function parseFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

export class LifecyclePolicy {
  private readonly flags: Record<LifecycleFeature, boolean>;
  private readonly metrics = new Map<LifecycleFeature, LifecyclePolicyMetrics>();

  constructor(overrides: Partial<Record<LifecycleFeature, boolean>> = {}) {
    this.flags = { ...DEFAULT_FLAGS };
    (Object.keys(this.flags) as LifecycleFeature[]).forEach((feature) => {
      const envValue = process.env[FLAG_ENV_KEYS[feature]];
      this.flags[feature] = parseFlag(envValue, this.flags[feature]);
    });
    for (const [feature, value] of Object.entries(overrides) as Array<[LifecycleFeature, boolean]>) {
      this.flags[feature] = value;
    }
  }

  isEnabled(feature: LifecycleFeature): boolean {
    return this.flags[feature] ?? true;
  }

  evaluate(feature: LifecycleFeature, context: Record<string, unknown> = {}): LifecyclePolicyDecision {
    const enabled = this.isEnabled(feature);
    const contextHash = createHash('sha1')
      .update(JSON.stringify({ feature, context }))
      .digest('hex')
      .slice(0, 12);

    const decision: LifecyclePolicyDecision = {
      feature,
      enabled,
      failOpen: true,
      reason: enabled ? 'enabled-by-policy' : `disabled-by-${FLAG_ENV_KEYS[feature]}`,
      timestamp: Date.now(),
      contextHash,
    };

    const current = this.metrics.get(feature) ?? { total: 0, enabled: 0, disabled: 0 };
    current.total += 1;
    if (enabled) current.enabled += 1;
    else current.disabled += 1;
    current.lastDecision = decision;
    this.metrics.set(feature, current);

    return decision;
  }

  getMetrics() {
    const serialized: Record<string, LifecyclePolicyMetrics> = {};
    for (const [feature, metric] of this.metrics.entries()) {
      serialized[feature] = { ...metric };
    }
    return {
      flags: { ...this.flags },
      decisions: serialized,
      generatedAt: Date.now(),
    };
  }
}

export const createLifecyclePolicy = (overrides: Partial<Record<LifecycleFeature, boolean>> = {}) =>
  new LifecyclePolicy(overrides);
