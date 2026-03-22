import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import { openSynapseDb } from './synapse/db/client.js';
import { openArchitectsDb } from './architects/db/client.js';

const SYNAPSE_MARKERS = {
  start: '<!-- nexus-prime:synapse:start -->',
  end: '<!-- nexus-prime:synapse:end -->',
};

const ARCHITECTS_MARKERS = {
  start: '<!-- nexus-prime:architects:start -->',
  end: '<!-- nexus-prime:architects:end -->',
};

const ENV_MARKERS = {
  start: '# nexus-prime:v5-runtime:start',
  end: '# nexus-prime:v5-runtime:end',
};

const GITIGNORE_MARKERS = {
  start: '# nexus-prime:v5-runtime:start',
  end: '# nexus-prime:v5-runtime:end',
};

function upsertManagedBlock(existing: string, start: string, end: string, block: string): string {
  const nextBlock = `${start}\n${block.trim()}\n${end}`;
  const startIndex = existing.indexOf(start);
  const endIndex = existing.indexOf(end);
  if (startIndex >= 0 && endIndex > startIndex) {
    return `${existing.slice(0, startIndex).trimEnd()}\n\n${nextBlock}\n${existing.slice(endIndex + end.length).trimStart()}`.trimEnd() + '\n';
  }
  return `${existing.trimEnd()}\n\n${nextBlock}\n`;
}

function readText(targetPath: string): string {
  return fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';
}

function synapseBlock(): string {
  return [
    '## Synapse Operative Protocol',
    '> Only active when env SYNAPSE_OPERATIVE_ID is set.',
    '',
    'IF SYNAPSE_OPERATIVE_ID is set:',
    '1. `nexus_synapse_sortie_start(operativeId)` first in every session',
    '2. `nexus_synapse_echo(missionTitle)` before work',
    '3. `nexus_synapse_cost_report(...)` after significant LLM usage',
    '4. `nexus_synapse_mission_progress(...)` after meaningful findings',
    '5. `nexus_synapse_request_approval(...)` before delete/overwrite/reset and wait',
    '6. `nexus_synapse_sortie_end(...)` last in every session',
    '7. Check `nexus_architects_relay_inbox(...)` at session start',
    '8. Do not call `nexus_session_bootstrap` directly inside a Synapse sortie',
  ].join('\n');
}

function architectsBlock(): string {
  return [
    '## Architects Operative Protocol',
    '> Only active when env ARCHITECTS_OPERATIVE_ID is set.',
    '',
    'IF ARCHITECTS_OPERATIVE_ID is set:',
    '1. `nexus_architects_worklist_get(worklistId)` at session start',
    '2. `nexus_architects_workitem_claim(workItemId, operativeId)` before any work',
    '3. Work only on the branch assigned to that WorkItem',
    '4. `nexus_architects_workitem_complete(...)` when done or blocked',
    '5. Never push directly to main',
    '6. Use `nexus_architects_relay_send(...)` for operative-to-operative messages',
    '7. Escalate 2+ sortie blockers to ward via relay instead of waiting silently',
  ].join('\n');
}

function runtimeEnvBlock(): string {
  return [
    ENV_MARKERS.start,
    '# ── Nexus Synapse ─────────────────────────',
    'SYNAPSE_ENABLED=true',
    'SYNAPSE_OPERATIVE_ID=',
    'SYNAPSE_MAX_OPERATIVES_PER_TEAM=5',
    'SYNAPSE_DEFAULT_BUDGET_USD=50.0',
    'SYNAPSE_SORTIE_INTERVAL_MS=30000',
    'SYNAPSE_COMPACTION_BUDGET_TOKENS=100000',
    'SYNAPSE_ECHO_ENABLED=true',
    'SYNAPSE_ECHO_MIN_SIMILARITY=0.70',
    'SYNAPSE_LEDGER_ENABLED=true',
    'SYNAPSE_LEDGER_COMMIT_INTERVAL_MS=60000',
    'SYNAPSE_WATCHDOG_ENABLED=true',
    'SYNAPSE_WATCHDOG_PATROL_INTERVAL_MS=120000',
    'SYNAPSE_WATCHDOG_STALL_MS=300000',
    'SYNAPSE_WATCHDOG_ZOMBIE_MS=900000',
    '',
    '# ── Nexus Architects ──────────────────────',
    'ARCHITECTS_ENABLED=true',
    'ARCHITECTS_OPERATIVE_ID=',
    'ARCHITECTS_MAX_CONCURRENT=-1',
    'ARCHITECTS_SENTINEL_PATROL_MS=120000',
    'ARCHITECTS_WARD_PATROL_MS=180000',
    'ARCHITECTS_CONVERGENCE_STRATEGY=bisecting',
    ENV_MARKERS.end,
  ].join('\n');
}

function runtimeGitignoreBlock(): string {
  return [
    GITIGNORE_MARKERS.start,
    '.synapse/*.db',
    '.architects/*.db',
    GITIGNORE_MARKERS.end,
  ].join('\n');
}

function writeRuntimeDocs(root: string, target: 'synapse' | 'architects' | 'all'): void {
  const docTargets = [path.join(root, 'AGENTS.md')];
  ['CLAUDE.md', 'Claude.md'].forEach((name) => {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) docTargets.push(candidate);
  });
  for (const docPath of docTargets) {
    let content = readText(docPath);
    if (target === 'synapse' || target === 'all') {
      content = upsertManagedBlock(content, SYNAPSE_MARKERS.start, SYNAPSE_MARKERS.end, synapseBlock());
    }
    if (target === 'architects' || target === 'all') {
      content = upsertManagedBlock(content, ARCHITECTS_MARKERS.start, ARCHITECTS_MARKERS.end, architectsBlock());
    }
    fs.writeFileSync(docPath, content, 'utf8');
  }
}

function upsertWholeBlock(targetPath: string, start: string, end: string, block: string): void {
  const existing = readText(targetPath);
  const updated = upsertManagedBlock(existing, start, end, block.replace(start, '').replace(end, '').trim());
  fs.writeFileSync(targetPath, updated, 'utf8');
}

export async function runRuntimeSetup(target: 'synapse' | 'architects' | 'all' = 'all', root: string = process.cwd()): Promise<void> {
  if (target === 'synapse' || target === 'all') {
    const db = openSynapseDb(root);
    db.close();
    console.log('  ✅ Synapse: .synapse/synapse.db initialised');
  }
  if (target === 'architects' || target === 'all') {
    const db = openArchitectsDb(root);
    db.close();
    console.log('  ✅ Architects: .architects/architects.db initialised');
  }

  writeRuntimeDocs(root, target);
  upsertWholeBlock(path.join(root, '.env.example'), ENV_MARKERS.start, ENV_MARKERS.end, runtimeEnvBlock());
  upsertWholeBlock(path.join(root, '.gitignore'), GITIGNORE_MARKERS.start, GITIGNORE_MARKERS.end, runtimeGitignoreBlock());

  console.log('\n  ✅ Nexus Prime v5 online — Synapse + Architects active.');
}

export function buildRuntimeSetupCommand(): Command {
  const runtime = new Command('runtime')
    .description('Install Synapse and Architects runtime state into the current workspace')
    .action(async () => {
      await runRuntimeSetup('all');
    });
  (['synapse', 'architects', 'all'] as const).forEach((target) => {
    runtime
      .addCommand(
        new Command(target)
          .description(`Initialize ${target === 'all' ? 'Synapse and Architects' : target}`)
          .action(async () => {
            await runRuntimeSetup(target);
          }),
      );
  });
  return runtime;
}
