import { listSpecialists } from '../../engines/specialist-roster.js';
import type { SkillArtifact } from '../../engines/skill-runtime.js';
import type { MandateSignals } from '../types.js';

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  const overlap = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : overlap / union;
}

export function matchNPAssets(signals: MandateSignals, skills: SkillArtifact[]): {
  skills: SkillArtifact[];
  specialists: Array<{ specialistId: string; name: string }>;
} {
  const signalTokens = tokenize([signals.domains.join(' '), signals.subGoalHints.join(' ')].join(' '));
  const rankedSkills = [...skills]
    .map((skill) => ({
      skill,
      score: jaccard(signalTokens, tokenize([skill.name, skill.domain ?? '', skill.instructions ?? ''].join(' '))),
    }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.skill);

  const rankedSpecialists = listSpecialists()
    .map((specialist) => ({
      specialistId: specialist.specialistId,
      name: specialist.name,
      score: jaccard(signalTokens, tokenize([specialist.name, specialist.division, specialist.description].join(' '))),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map(({ specialistId, name }) => ({ specialistId, name }));

  return {
    skills: rankedSkills,
    specialists: rankedSpecialists,
  };
}
