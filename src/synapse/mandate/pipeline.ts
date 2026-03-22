import { randomUUID } from 'crypto';
import { nexusEventBus } from '../../engines/event-bus.js';
import { planTask } from '../../engines/task-planner.js';
import { parseMandateSignals } from './intent-parser.js';
import { matchNPAssets } from './asset-matcher.js';
import { insertStrikeTeam, insertMission, getStrikeTeam } from '../missions/crud.js';
import { insertOperative, updateOperativeMission } from '../operatives/crud.js';
import { SynapseConfig } from '../config.js';
import type { MissionComplexity, StrikeTeam, SynapseDb, SynapseProviders } from '../types.js';

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function deriveMissionTitles(mandateText: string, complexity: MissionComplexity, hints: string[], planner: ReturnType<typeof planTask>): string[] {
  const plannerHints = [
    ...planner.plannerState.selectedSpecialists.map((specialist) => `Coordinate with ${specialist.name}`),
    ...planner.plannerState.selectedWorkflows.map((workflow) => `Execute workflow: ${workflow}`),
    ...planner.task.successCriteria,
  ];
  const normalized = unique(
    [...hints, ...plannerHints]
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 10),
  ).slice(0, Math.max(1, planner.task.workers));
  if (normalized.length > 0) return normalized;
  return [`${complexity.toUpperCase()}: ${mandateText}`];
}

export async function executeMandatePipeline(
  db: SynapseDb,
  mandateText: string,
  providers: SynapseProviders,
  opts: { budgetUsd?: number; maxOperatives?: number } = {},
): Promise<StrikeTeam> {
  const signals = parseMandateSignals(mandateText);
  const matched = matchNPAssets(signals, providers.skillRuntime.listArtifacts());
  const planner = planTask({
    goal: mandateText,
    files: [],
    workers: Math.max(2, Math.min(opts.maxOperatives ?? SynapseConfig.maxOpsPerTeam, SynapseConfig.maxOpsPerTeam)),
    roles: ['planner', 'coder'],
    strategies: ['standard'],
    verifyCommands: [],
    successCriteria: signals.subGoalHints,
    rollbackPolicy: 'patch-revert',
    timeoutMs: 120_000,
    skillPolicy: { mode: 'session-only', allowMutateSkills: true },
    backendSelectors: {},
    skillNames: matched.skills.slice(0, 5).map((skill) => skill.name),
    workflowSelectors: [],
    hookSelectors: [],
    automationSelectors: [],
    connectorBindings: [],
    actions: [],
    inlineSkills: [],
    promotionPolicy: { autoPromoteSkills: false, autoPromoteWorkflows: false, globalThreshold: 0.9 },
    derivationPolicy: { mode: 'manual' },
    checkpointPolicy: [],
    backendMode: 'default',
    shieldPolicy: 'balanced',
    memoryPolicy: { mode: 'balanced', quarantineTag: '#quarantine' },
    crewSelectors: [],
    specialistSelectors: matched.specialists.map((specialist) => specialist.specialistId),
    optimizationProfile: 'standard',
    reviewPolicy: { mode: 'runtime-only' },
    releasePolicy: { mode: 'skip' },
    continuationPolicy: { mode: 'manual' },
    continuationDepth: 0,
    suppressedAutomationIds: [],
    executionMode: 'autonomous',
    manualOverrides: [],
  });

  const missionTitles = deriveMissionTitles(mandateText, signals.complexity, signals.subGoalHints, planner);
  const maxOps = Math.min(opts.maxOperatives ?? SynapseConfig.maxOpsPerTeam, Math.max(1, matched.skills.length || 1));
  const budget = opts.budgetUsd ?? SynapseConfig.defaultBudgetUsd;

  const team = db.transaction(() => {
    const teamId = randomUUID();
    const operativeIds = Array.from({ length: maxOps }, (_, index) => {
      const skill = matched.skills[index] ?? matched.skills[0];
      const specialist = matched.specialists[index] ?? matched.specialists[0] ?? null;
      const operative = insertOperative(db, {
        id: randomUUID(),
        name: `operative-${teamId.slice(0, 4)}-${index + 1}`,
        skillId: skill?.name ?? null,
        specialistId: specialist?.specialistId ?? null,
        budgetCapUsd: budget / maxOps,
        strikeTeamId: teamId,
        sortieIntervalMs: SynapseConfig.sortieIntervalMs,
      });
      nexusEventBus.emit('synapse.operative.hired', {
        operativeId: operative.id,
        name: operative.name,
        skillId: operative.skillId,
        strikeTeamId: teamId,
      });
      return operative.id;
    });

    const missionIds = missionTitles.map((title, index) => {
      const operativeId = operativeIds[index % operativeIds.length];
      const mission = insertMission(db, {
        id: randomUUID(),
        strikeTeamId: teamId,
        title,
        complexity: signals.complexity,
        status: 'open',
        assignedOperativeId: operativeId,
        requiresApprovalGate: signals.complexity === 'mutate',
      });
      updateOperativeMission(db, operativeId, mission.id, teamId);
      nexusEventBus.emit('synapse.mission.assigned', {
        operativeId,
        missionId: mission.id,
        title: mission.title,
      });
      return mission.id;
    });

    insertStrikeTeam(db, {
      id: teamId,
      mandateText,
      operativeIds,
      missionIds,
      blueprintId: null,
      status: 'active',
    });

    nexusEventBus.emit('synapse.striketeam.deployed', {
      strikeTeamId: teamId,
      operativeCount: operativeIds.length,
      missionCount: missionIds.length,
    });
    providers.memory.store(`[Synapse:Mandate] ${mandateText}`, 0.85, ['#synapse', '#mandate', `#team:${teamId}`]);
    return getStrikeTeam(db, teamId)!;
  })();

  return team;
}
