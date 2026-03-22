import test from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import { SkillLearnerEngine } from '../src/engines/skill-learner.js';

test('SkillLearnerEngine preserves runtime outcomes and mirrors them into memory', () => {
  const recorded: Array<{ skillId: string; outcome: unknown }> = [];
  const derived: unknown[] = [];
  const memoryCalls: unknown[][] = [];
  const learner = new SkillLearnerEngine({
    recordOutcome(skillId: string, outcome: unknown) {
      recorded.push({ skillId, outcome });
    },
    deriveFromSignals(signals: unknown) {
      derived.push(signals);
    },
  } as any, {
    store(...args: unknown[]) {
      memoryCalls.push(args);
      return 'memory-1';
    },
  } as any);

  learner.analyzeRun({
    task: 'Implement resilient orchestration',
    steps: [{
      id: 'runtime-execution',
      status: 'completed',
      details: {
        state: 'merged',
        verifiedWorkers: 2,
      },
    }],
  } as any, {
    selectedSkills: [{ id: 'skill-alpha' }],
  } as any);

  equal(recorded.length, 1);
  equal(recorded[0].skillId, 'skill-alpha');
  equal(derived.length, 1);
  equal(memoryCalls.length, 1);
  deepEqual(memoryCalls[0][2], ['#skill-outcome', '#task-type:unknown', '#skill:skill-alpha']);
  deepEqual(memoryCalls[0][5], {
    tier: 'hippocampus',
    state: 'active',
    trust: 0.85,
    source: 'system',
    provenance: {
      source: 'runtime',
      summary: 'Skill learner outcome',
      tags: ['#skill-outcome'],
    },
  });
});

test('SkillLearnerEngine remains backward compatible when memory is absent', () => {
  const recorded: string[] = [];
  const learner = new SkillLearnerEngine({
    recordOutcome(skillId: string) {
      recorded.push(skillId);
    },
    deriveFromSignals() {
      return undefined;
    },
  } as any);

  learner.analyzeRun({
    task: 'Retry stabilization',
    steps: [{
      id: 'runtime-execution',
      status: 'failed',
      details: {
        state: 'failed',
        verifiedWorkers: 0,
      },
    }],
  } as any, {
    selectedSkills: [{ id: 'skill-beta' }],
  } as any);

  deepEqual(recorded, ['skill-beta']);
});
