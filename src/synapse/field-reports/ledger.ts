import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { SynapseConfig } from '../config.js';
import type { FieldReport } from '../types.js';

const pending: Array<{ root: string; filePath: string }> = [];
let commitTimer: NodeJS.Timeout | null = null;

function isGitRepo(root: string): boolean {
  return fs.existsSync(path.join(root, '.git'));
}

export function renderFieldReportMarkdown(report: FieldReport): string {
  const metadata = JSON.stringify(report);
  return [
    `<!-- synapse-field-report:${metadata} -->`,
    `# Field Report: ${report.missionTitle}`,
    '',
    `- Operative: ${report.operativeId}`,
    `- Sortie: ${report.sortieId}`,
    `- Status: ${report.status}`,
    `- Tokens: ${report.tokensUsed}`,
    `- Cost: ${report.costUsd}`,
    '',
    '## Findings',
    report.findings || 'None recorded.',
    '',
    '## Files Changed',
    ...(report.filesChanged.length ? report.filesChanged.map((entry) => `- ${entry}`) : ['- none']),
    '',
    '## Blockers',
    report.blockersEncountered || 'None',
    '',
    '## Next Recommended Action',
    report.nextRecommendedAction || 'None',
    '',
  ].join('\n');
}

export function writeLedgerMarkdown(root: string, report: FieldReport): string | null {
  try {
    const dir = path.join(root, '.synapse', 'ledger', report.strikeTeamId ?? 'solo', report.operativeId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${report.id}.md`);
    fs.writeFileSync(filePath, renderFieldReportMarkdown(report), 'utf8');
    return filePath;
  } catch {
    return null;
  }
}

export function scheduleFieldReportLedgerExport(root: string, report: FieldReport): string | null {
  const filePath = writeLedgerMarkdown(root, report);
  if (filePath) pending.push({ root, filePath });
  return filePath;
}

export function startLedgerBatchCommitter(): void {
  if (commitTimer || !SynapseConfig.ledgerEnabled) return;
  commitTimer = setInterval(() => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    const byRoot = new Map<string, string[]>();
    batch.forEach((entry) => {
      const list = byRoot.get(entry.root) ?? [];
      list.push(entry.filePath);
      byRoot.set(entry.root, list);
    });

    for (const [root, files] of byRoot) {
      if (!isGitRepo(root)) continue;
      try {
        execFileSync('git', ['add', ...files], { cwd: root, timeout: 5_000 });
        execFileSync('git', ['commit', '-m', `synapse: field reports [${files.length}]`, '--no-verify'], { cwd: root, timeout: 10_000 });
      } catch {
        files.forEach((filePath) => pending.push({ root, filePath }));
      }
    }
  }, SynapseConfig.ledgerCommitIntervalMs);
  commitTimer.unref();
}

export function stopLedgerBatchCommitter(): void {
  if (commitTimer) clearInterval(commitTimer);
  commitTimer = null;
}
