import type { EchoResult, SynapseDb } from '../types.js';
import type { MemoryEngine } from '../../engines/memory.js';

export async function queryEcho(
  db: SynapseDb,
  missionId: string | null,
  missionTitle: string,
  currentOperativeId: string,
  memory: MemoryEngine,
): Promise<EchoResult> {
  const priorSorties = missionId ? db.prepare(`
    SELECT s.id, fr.findings, fr.blockers_encountered, fr.status
    FROM synapse_sorties s
    JOIN synapse_field_reports fr ON fr.sortie_id = s.id
    WHERE s.mission_id = ? AND s.operative_id != ? AND s.status = 'completed'
    ORDER BY s.completed_at DESC LIMIT 5
  `).all(missionId, currentOperativeId) as any[] : [];

  const memoryHits = priorSorties.length === 0 && missionTitle.length > 6
    ? await memory.recall(`[FieldReport] ${missionTitle}`, 3)
    : [];

  if (priorSorties.length === 0 && memoryHits.length === 0) {
    return { found: false, summary: '', predecessorSortieIds: [], priorBlockers: [] };
  }

  const blockers = priorSorties.map((sortie) => sortie.blockers_encountered).filter(Boolean).slice(0, 3);
  const findings = [
    ...priorSorties.map((sortie) => sortie.findings),
    ...memoryHits,
  ].filter(Boolean).slice(0, 4);

  return {
    found: true,
    predecessorSortieIds: priorSorties.map((sortie) => sortie.id),
    priorBlockers: blockers,
    summary: [
      `[Echo: ${priorSorties.length} prior sortie(s)]`,
      blockers.length ? `Prior blockers: ${blockers.join('; ')}` : null,
      findings.length ? `Prior findings: ${findings.join(' | ')}` : null,
    ].filter(Boolean).join('\n'),
  };
}
