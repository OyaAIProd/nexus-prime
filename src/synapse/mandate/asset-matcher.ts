import { listSpecialists } from '../../engines/specialist-roster.js';
import { createEmbedder } from '../../engines/embedder.js';
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

const specialistEmbeddings = new Map<string, number[]>();

export function matchNPAssets(signals: MandateSignals, skills: SkillArtifact[]): {
  skills: SkillArtifact[];
  specialists: Array<{ specialistId: string; name: string }>;
} {
  const embedder = createEmbedder();
  const signalText = [signals.domains.join(' '), signals.subGoalHints.join(' ')].join(' ').trim();
  const signalTokens = tokenize(signalText);
  const signalVector = embedder.embedSync(signalText);
  const rankedSkills = [...skills]
    .map((skill) => ({
      skill,
      score: scoreSemanticMatch(
        signalTokens,
        signalVector,
        [skill.name, skill.domain ?? '', skill.instructions ?? ''].join(' '),
        skill.embedding,
        embedder,
      ),
    }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.skill);

  const rankedSpecialists = listSpecialists()
    .map((specialist) => ({
      specialistId: specialist.specialistId,
      name: specialist.name,
      score: scoreSemanticMatch(
        signalTokens,
        signalVector,
        [specialist.name, specialist.division, specialist.description].join(' '),
        specialistEmbeddings.get(specialist.specialistId),
        embedder,
        specialist.specialistId,
      ),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map(({ specialistId, name }) => ({ specialistId, name }));

  return {
    skills: rankedSkills,
    specialists: rankedSpecialists,
  };
}

function scoreSemanticMatch(
  signalTokens: Set<string>,
  signalVector: number[],
  artifactText: string,
  cachedEmbedding: number[] | undefined,
  embedder: ReturnType<typeof createEmbedder>,
  cacheKey?: string,
): number {
  const lexical = jaccard(signalTokens, tokenize(artifactText));
  const embedding = Array.isArray(cachedEmbedding) && cachedEmbedding.length === signalVector.length
    ? cachedEmbedding
    : embedder.embedSync(artifactText);
  if (cacheKey) {
    specialistEmbeddings.set(cacheKey, embedding);
  }
  const semantic = Math.max(0, embedder.cosineSimilarity(signalVector, embedding));
  return semantic * 0.8 + lexical * 0.2;
}
