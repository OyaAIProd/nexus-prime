import fs from 'fs';
import path from 'path';
import type { FieldReport, SynapseDb } from '../types.js';

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(next));
    } else if (entry.isFile() && next.endsWith('.md')) {
      files.push(next);
    }
  }
  return files;
}

export function parseLedgerMarkdown(content: string): FieldReport | null {
  const firstLine = content.split('\n', 1)[0] ?? '';
  const match = firstLine.match(/^<!-- synapse-field-report:(.+) -->$/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as FieldReport;
  } catch {
    return null;
  }
}

export function fieldReportExists(db: SynapseDb, fieldReportId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM synapse_field_reports WHERE id=?').get(fieldReportId));
}

export function insertFieldReport(db: SynapseDb, report: FieldReport): void {
  db.prepare(`
    INSERT INTO synapse_field_reports (
      id, sortie_id, operative_id, strike_team_id, mission_title, findings, files_changed,
      blockers_encountered, next_recommended_action, tokens_used, cost_usd, ledger_path,
      status, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    report.id,
    report.sortieId,
    report.operativeId,
    report.strikeTeamId ?? null,
    report.missionTitle,
    report.findings,
    JSON.stringify(report.filesChanged ?? []),
    report.blockersEncountered ?? '',
    report.nextRecommendedAction ?? '',
    report.tokensUsed ?? 0,
    report.costUsd ?? 0,
    report.ledgerPath ?? null,
    report.status,
    report.completedAt,
  );
}

export function restoreSynapseFromLedger(db: SynapseDb, root: string): number {
  const ledgerDir = path.join(root, '.synapse', 'ledger');
  const files = walk(ledgerDir);
  let restored = 0;
  for (const filePath of files) {
    const parsed = parseLedgerMarkdown(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || fieldReportExists(db, parsed.id)) continue;
    insertFieldReport(db, parsed);
    restored += 1;
  }
  return restored;
}
