import type { ArchitectsRuntime } from './types.js';

function text(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function resolveOperativeId(value: unknown): string | null {
  const operativeId = String(value ?? process.env.ARCHITECTS_OPERATIVE_ID ?? '').trim();
  return operativeId || null;
}

export const architectsToolDefinitions = [
  {
    name: 'nexus_architects_blueprint_create',
    description: 'Instantiate an Architects blueprint and worklist.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        workflowId: { type: 'string' },
        variables: { type: 'object' },
        strikeTeamId: { type: 'string' },
      },
      required: ['title', 'workflowId'],
    },
  },
  {
    name: 'nexus_architects_worklist_get',
    description: 'Get worklist state.',
    inputSchema: { type: 'object', properties: { worklistId: { type: 'string' } }, required: ['worklistId'] },
  },
  {
    name: 'nexus_architects_workitem_claim',
    description: 'Claim a work item.',
    inputSchema: { type: 'object', properties: { workItemId: { type: 'string' }, operativeId: { type: 'string' } }, required: ['workItemId'] },
  },
  {
    name: 'nexus_architects_workitem_complete',
    description: 'Complete a claimed work item.',
    inputSchema: {
      type: 'object',
      properties: {
        workItemId: { type: 'string' },
        operativeId: { type: 'string' },
        status: { type: 'string' },
        branch: { type: 'string' },
      },
      required: ['workItemId', 'status'],
    },
  },
  {
    name: 'nexus_architects_relay_send',
    description: 'Send a typed relay message.',
    inputSchema: {
      type: 'object',
      properties: {
        fromOperativeId: { type: 'string' },
        toId: { type: 'string' },
        target: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        priority: { type: 'string' },
      },
      required: ['toId', 'target', 'subject', 'body'],
    },
  },
  {
    name: 'nexus_architects_relay_inbox',
    description: 'Read a relay inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        operativeId: { type: 'string' },
        strikeTeamId: { type: 'string' },
        markRead: { type: 'boolean' },
      },
      required: [],
    },
  },
  {
    name: 'nexus_architects_sentinel_report',
    description: 'Run a sentinel patrol for one strike team.',
    inputSchema: { type: 'object', properties: { strikeTeamId: { type: 'string' } }, required: ['strikeTeamId'] },
  },
  {
    name: 'nexus_architects_convergence_run',
    description: 'Run the convergence queue for one worklist.',
    inputSchema: { type: 'object', properties: { worklistId: { type: 'string' } }, required: ['worklistId'] },
  },
  {
    name: 'nexus_architects_dispatch_status',
    description: 'Inspect dispatch governor state.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'nexus_architects_ward_escalations',
    description: 'Inspect ward escalation history.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

export async function handleArchitectsToolCall(name: string, args: Record<string, any>, architects: ArchitectsRuntime | null) {
  if (!architects) return text({ error: 'architects-disabled' });

  switch (name) {
    case 'nexus_architects_blueprint_create':
      return text(architects.instantiateBlueprint({
        title: String(args.title),
        workflowId: String(args.workflowId),
        variables: args.variables ?? {},
        strikeTeamId: args.strikeTeamId ? String(args.strikeTeamId) : null,
      }));
    case 'nexus_architects_worklist_get':
      return text(architects.getWorklist(String(args.worklistId)));
    case 'nexus_architects_workitem_claim':
      if (!resolveOperativeId(args.operativeId)) return text({ error: 'ARCHITECTS_OPERATIVE_ID not set' });
      return text(await architects.claimWorkItem(String(args.workItemId), resolveOperativeId(args.operativeId)!));
    case 'nexus_architects_workitem_complete':
      if (!resolveOperativeId(args.operativeId)) return text({ error: 'ARCHITECTS_OPERATIVE_ID not set' });
      return text(await architects.completeWorkItem(String(args.workItemId), resolveOperativeId(args.operativeId)!, String(args.status) as any, args.branch ? String(args.branch) : null));
    case 'nexus_architects_relay_send':
      if (!resolveOperativeId(args.fromOperativeId)) return text({ error: 'ARCHITECTS_OPERATIVE_ID not set' });
      return text(await architects.sendRelay({
        fromOperativeId: resolveOperativeId(args.fromOperativeId)!,
        toId: String(args.toId),
        target: String(args.target) as any,
        subject: String(args.subject),
        body: String(args.body),
        priority: args.priority ? String(args.priority) as any : 'normal',
      }));
    case 'nexus_architects_relay_inbox':
      return text(architects.getRelayInbox({
        operativeId: resolveOperativeId(args.operativeId) ?? undefined,
        strikeTeamId: args.strikeTeamId ? String(args.strikeTeamId) : undefined,
        markRead: Boolean(args.markRead),
      }));
    case 'nexus_architects_sentinel_report':
      return text(await architects.getSentinelReport(String(args.strikeTeamId)));
    case 'nexus_architects_convergence_run':
      return text(await architects.runConvergenceQueue(String(args.worklistId)));
    case 'nexus_architects_dispatch_status':
      return text(architects.getDispatchStatus());
    case 'nexus_architects_ward_escalations':
      return text(architects.getWardEscalations());
    default:
      return null;
  }
}
