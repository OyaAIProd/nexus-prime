import type { SynapseRuntime } from './types.js';

function text(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function resolveOperativeId(value: unknown): string | null {
  const operativeId = String(value ?? process.env.SYNAPSE_OPERATIVE_ID ?? '').trim();
  return operativeId || null;
}

export const synapseToolDefinitions = [
  {
    name: 'nexus_synapse_mandate',
    description: 'Deploy a Synapse Strike Team from a top-level mandate.',
    inputSchema: {
      type: 'object',
      properties: {
        mandateText: { type: 'string' },
        budgetUsd: { type: 'number' },
        maxOperatives: { type: 'number' },
      },
      required: ['mandateText'],
    },
  },
  {
    name: 'nexus_synapse_hire',
    description: 'Manually create an operative.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        skillId: { type: 'string' },
        specialistId: { type: 'string' },
        budgetCapUsd: { type: 'number' },
      },
      required: ['name'],
    },
  },
  {
    name: 'nexus_synapse_assign_mission',
    description: 'Deploy a one-off mandate as a mission assignment.',
    inputSchema: {
      type: 'object',
      properties: {
        mandateText: { type: 'string' },
      },
      required: ['mandateText'],
    },
  },
  {
    name: 'nexus_synapse_sortie_start',
    description: 'Run a sortie for one operative.',
    inputSchema: { type: 'object', properties: { operativeId: { type: 'string' } }, required: [] },
  },
  {
    name: 'nexus_synapse_sortie_end',
    description: 'Alias for sortie completion reporting.',
    inputSchema: { type: 'object', properties: { operativeId: { type: 'string' } }, required: [] },
  },
  {
    name: 'nexus_synapse_field_report',
    description: 'Submit a field report payload.',
    inputSchema: { type: 'object', properties: { report: { type: 'object' } }, required: ['report'] },
  },
  {
    name: 'nexus_synapse_cost_report',
    description: 'Return basic cost telemetry for an operative.',
    inputSchema: { type: 'object', properties: { operativeId: { type: 'string' } }, required: ['operativeId'] },
  },
  {
    name: 'nexus_synapse_request_approval',
    description: 'Create an approval gate request.',
    inputSchema: {
      type: 'object',
      properties: {
        operativeId: { type: 'string' },
        missionId: { type: 'string' },
        action: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['action', 'description'],
    },
  },
  {
    name: 'nexus_synapse_echo',
    description: 'Query predecessor findings.',
    inputSchema: {
      type: 'object',
      properties: {
        missionId: { type: 'string' },
        missionTitle: { type: 'string' },
        currentOperativeId: { type: 'string' },
      },
      required: ['missionTitle'],
    },
  },
  {
    name: 'nexus_synapse_mission_progress',
    description: 'Persist a mission progress note.',
    inputSchema: {
      type: 'object',
      properties: {
        operativeId: { type: 'string' },
        missionId: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['note'],
    },
  },
  {
    name: 'nexus_synapse_striketeam_status',
    description: 'Get strike team status.',
    inputSchema: { type: 'object', properties: { strikeTeamId: { type: 'string' } }, required: [] },
  },
  {
    name: 'nexus_synapse_health',
    description: 'Get operative health.',
    inputSchema: { type: 'object', properties: { operativeId: { type: 'string' } }, required: [] },
  },
];

export async function handleSynapseToolCall(name: string, args: Record<string, any>, synapse: SynapseRuntime | null) {
  if (!synapse) return text({ error: 'synapse-disabled' });

  switch (name) {
    case 'nexus_synapse_mandate':
    case 'nexus_synapse_assign_mission':
      return text(await synapse.executeMandatePipeline(String(args.mandateText ?? args.goal ?? ''), {
        budgetUsd: args.budgetUsd == null ? undefined : Number(args.budgetUsd),
        maxOperatives: args.maxOperatives == null ? undefined : Number(args.maxOperatives),
      }));
    case 'nexus_synapse_sortie_start':
    case 'nexus_synapse_sortie_end':
      if (!resolveOperativeId(args.operativeId)) return text({ error: 'SYNAPSE_OPERATIVE_ID not set' });
      return text(await synapse.runSortie(resolveOperativeId(args.operativeId)!));
    case 'nexus_synapse_request_approval':
      if (!resolveOperativeId(args.operativeId)) return text({ error: 'SYNAPSE_OPERATIVE_ID not set' });
      return text(synapse.requestApproval({
        operativeId: resolveOperativeId(args.operativeId)!,
        missionId: args.missionId ? String(args.missionId) : null,
        action: String(args.action),
        description: String(args.description),
      }));
    case 'nexus_synapse_echo':
      if (!resolveOperativeId(args.currentOperativeId)) return text({ error: 'SYNAPSE_OPERATIVE_ID not set' });
      return text(await synapse.queryEcho({
        missionId: args.missionId ? String(args.missionId) : null,
        missionTitle: String(args.missionTitle),
        currentOperativeId: resolveOperativeId(args.currentOperativeId)!,
      }));
    case 'nexus_synapse_mission_progress':
      if (!resolveOperativeId(args.operativeId)) return text({ error: 'SYNAPSE_OPERATIVE_ID not set' });
      return text({
        note: synapse.noteMissionProgress(resolveOperativeId(args.operativeId)!, args.missionId ? String(args.missionId) : null, String(args.note)),
      });
    case 'nexus_synapse_striketeam_status':
      return text(synapse.getStrikeTeamStatus(args.strikeTeamId ? String(args.strikeTeamId) : undefined));
    case 'nexus_synapse_health':
    case 'nexus_synapse_cost_report':
      return text(synapse.getOperativeHealth(resolveOperativeId(args.operativeId) ?? undefined));
    case 'nexus_synapse_field_report':
      return text(synapse.submitFieldReport(args.report));
    case 'nexus_synapse_hire':
      return text({ error: 'manual-hire-not-exposed', detail: 'Use mandate deployment for operative creation.' });
    default:
      return null;
  }
}
