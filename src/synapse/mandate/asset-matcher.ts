import { listSpecialists } from '../../engines/specialist-roster.js';
import { createEmbedder } from '../../engines/embedder.js';
import { computeSemanticScore, tokenizeSemanticText } from '../../engines/semantic-ranking.js';
import type { SkillArtifact } from '../../engines/skill-runtime.js';
import type { MandateSignals } from '../types.js';

function tokenize(text: string): Set<string> {
  return tokenizeSemanticText(text);
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
  const embedding = Array.isArray(cachedEmbedding) && cachedEmbedding.length === signalVector.length
    ? cachedEmbedding
    : embedder.embedSync(artifactText);
  if (cacheKey) {
    specialistEmbeddings.set(cacheKey, embedding);
  }
  return computeSemanticScore({
    query: [...signalTokens].join(' '),
    queryVector: signalVector,
    candidateText: artifactText,
    candidateVector: embedding,
    lexicalTexts: [artifactText],
    embedder,
  }).final;
}
