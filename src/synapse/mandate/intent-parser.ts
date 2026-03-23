import type { MandateSignals, MissionComplexity } from '../types.js';

const DOMAIN_WEIGHTS: Array<{ domain: string; keywords: string[]; weight?: number }> = [
  { domain: 'backend', keywords: ['backend', 'server', 'service', 'runtime', 'database', 'db', 'persistence'] },
  { domain: 'frontend', keywords: ['frontend', 'ui', 'ux', 'dashboard', 'client', 'browser', 'layout'] },
  { domain: 'api', keywords: ['api', 'endpoint', 'contract', 'binding', 'integration', 'webhook'] },
  { domain: 'testing', keywords: ['test', 'testing', 'qa', 'verify', 'validation', 'regression'] },
  { domain: 'orchestration', keywords: ['orchestration', 'orchestrate', 'control plane', 'runtime', 'planner', 'workflow', 'multiagent', 'multi-agent', 'pod'] },
  { domain: 'review', keywords: ['review', 'audit', 'cto', 'production', 'readiness', 'assessment'] },
  { domain: 'performance', keywords: ['performance', 'latency', 'lag', 'slow', 'optimize', 'cache'] },
  { domain: 'governance', keywords: ['guardrail', 'approval', 'governance', 'policy', 'safety'] },
  { domain: 'synapse', keywords: ['synapse', 'operative', 'sortie', 'field report'] },
  { domain: 'architects', keywords: ['architects', 'worklist', 'work item', 'convergence', 'sentinel'] },
  { domain: 'docs', keywords: ['docs', 'documentation', 'readme'] },
  { domain: 'auth', keywords: ['auth', 'login', 'session', 'permission'] },
];

function scoreDomain(text: string, keywords: string[]): number {
  return keywords.reduce((score, keyword) => score + (text.includes(keyword) ? (keyword.includes(' ') ? 1.2 : 1) : 0), 0);
}

function inferComplexity(text: string): MissionComplexity {
  const lower = text.toLowerCase();
  if (/\b(delete|overwrite|reset|rename|migrate|refactor|implement|build|create|write|patch|fix|improve|harden)\b/.test(lower)) return 'mutate';
  if (/\b(plan|review|investigate|design|coordinate|orchestrate|audit|assess|analyze)\b/.test(lower)) return 'orchestrate';
  return 'read';
}

export function parseMandateSignals(mandateText: string): MandateSignals {
  const lower = mandateText.toLowerCase();
  const rankedDomains = DOMAIN_WEIGHTS
    .map((entry) => ({
      domain: entry.domain,
      score: scoreDomain(lower, entry.keywords) * (entry.weight ?? 1),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)
    .map((entry) => entry.domain);
  const subGoalHints = mandateText
    .split(/[\n.;:]/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 12)
    .slice(0, 6);

  return {
    domains: rankedDomains.length > 0 ? rankedDomains : ['general'],
    complexity: inferComplexity(mandateText),
    subGoalHints: subGoalHints.length > 0 ? subGoalHints : [mandateText.trim()],
  };
}
