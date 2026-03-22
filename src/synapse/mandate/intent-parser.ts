import type { MandateSignals, MissionComplexity } from '../types.js';

const DOMAIN_KEYWORDS = ['auth', 'backend', 'frontend', 'ui', 'dashboard', 'database', 'workflow', 'agent', 'cli', 'docs', 'testing', 'api'];

function inferComplexity(text: string): MissionComplexity {
  const lower = text.toLowerCase();
  if (/\b(delete|overwrite|reset|rename|migrate|refactor|implement|build|create|write)\b/.test(lower)) return 'mutate';
  if (/\bplan|review|investigate|design|coordinate|orchestrate\b/.test(lower)) return 'orchestrate';
  return 'read';
}

export function parseMandateSignals(mandateText: string): MandateSignals {
  const lower = mandateText.toLowerCase();
  const domains = DOMAIN_KEYWORDS.filter((keyword) => lower.includes(keyword));
  const subGoalHints = mandateText
    .split(/[\n.;:]/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 12)
    .slice(0, 6);

  return {
    domains: domains.length > 0 ? domains : ['general'],
    complexity: inferComplexity(mandateText),
    subGoalHints: subGoalHints.length > 0 ? subGoalHints : [mandateText.trim()],
  };
}
