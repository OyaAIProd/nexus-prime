import assert from 'assert';
import { handleSynapseToolCall } from '../mcp-tools.js';
import { parseToolResult } from './helpers.js';

export async function run() {
  delete process.env.SYNAPSE_OPERATIVE_ID;

  const disabled = await handleSynapseToolCall('nexus_synapse_mandate', { mandateText: 'test' }, null);
  assert.deepStrictEqual(parseToolResult(disabled), { error: 'synapse-disabled' }, 'tools should surface disabled state when runtime is unavailable');

  const runtime = {
    executeMandatePipeline: async (mandateText: string) => ({ mandateText, id: 'team-1' }),
    runSortie: async (operativeId: string) => ({ operativeId, status: 'completed' }),
    requestApproval: (input: any) => input,
    queryEcho: async (input: any) => input,
    noteMissionProgress: (operativeId: string, missionId: string | null, note: string) => `${operativeId}:${missionId}:${note}`,
    getStrikeTeamStatus: () => ([]),
    getOperativeHealth: (operativeId?: string) => ({ operativeId: operativeId ?? null }),
    submitFieldReport: (report: any) => report,
  } as any;

  const missingEnv = await handleSynapseToolCall('nexus_synapse_sortie_start', {}, runtime);
  assert.deepStrictEqual(parseToolResult(missingEnv), { error: 'SYNAPSE_OPERATIVE_ID not set' }, 'operative-scoped tools should fail clearly when env is unset');

  process.env.SYNAPSE_OPERATIVE_ID = 'env-operative';
  const viaEnv = await handleSynapseToolCall('nexus_synapse_sortie_start', {}, runtime);
  assert.strictEqual(parseToolResult(viaEnv).operativeId, 'env-operative', 'operative-scoped tools should fall back to env-backed identity');

  delete process.env.SYNAPSE_OPERATIVE_ID;
}
