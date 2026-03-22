import assert from 'assert';
import { handleArchitectsToolCall } from '../mcp-tools.js';
import { parseToolResult } from './helpers.js';

export async function run() {
  delete process.env.ARCHITECTS_OPERATIVE_ID;

  const disabled = await handleArchitectsToolCall('nexus_architects_workitem_claim', { workItemId: 'item-1' }, null);
  assert.deepStrictEqual(parseToolResult(disabled), { error: 'architects-disabled' }, 'tools should surface disabled state when Architects is unavailable');

  const runtime = {
    getWorklist: (worklistId: string) => ({ worklistId }),
    claimWorkItem: async (workItemId: string, operativeId: string) => ({ workItemId, operativeId }),
    completeWorkItem: async (workItemId: string, operativeId: string, status: string) => ({ workItemId, operativeId, status }),
    sendRelay: async (input: any) => input,
    getRelayInbox: () => ([]),
    getSentinelReport: async (strikeTeamId: string) => ({ strikeTeamId }),
    runConvergenceQueue: async (worklistId: string) => ({ worklistId }),
    getDispatchStatus: () => ({ active: 0 }),
    getWardEscalations: () => ([]),
    instantiateBlueprint: (input: any) => input,
  } as any;

  const missingEnv = await handleArchitectsToolCall('nexus_architects_workitem_claim', { workItemId: 'item-1' }, runtime);
  assert.deepStrictEqual(parseToolResult(missingEnv), { error: 'ARCHITECTS_OPERATIVE_ID not set' }, 'operative-scoped Architects tools should fail clearly when env is unset');

  process.env.ARCHITECTS_OPERATIVE_ID = 'env-operative';
  const viaEnv = await handleArchitectsToolCall('nexus_architects_workitem_claim', { workItemId: 'item-1' }, runtime);
  assert.strictEqual(parseToolResult(viaEnv).operativeId, 'env-operative', 'operative-scoped Architects tools should fall back to env-backed identity');

  delete process.env.ARCHITECTS_OPERATIVE_ID;
}
