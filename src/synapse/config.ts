function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const SynapseConfig = {
  enabled: parseBoolean(process.env.SYNAPSE_ENABLED, true),
  maxOpsPerTeam: parseInteger(process.env.SYNAPSE_MAX_OPERATIVES_PER_TEAM, 5),
  defaultBudgetUsd: parseFloatNumber(process.env.SYNAPSE_DEFAULT_BUDGET_USD, 50),
  sortieIntervalMs: parseInteger(process.env.SYNAPSE_SORTIE_INTERVAL_MS, 30_000),
  compactionBudgetTokens: parseInteger(process.env.SYNAPSE_COMPACTION_BUDGET_TOKENS, 100_000),
  echoEnabled: parseBoolean(process.env.SYNAPSE_ECHO_ENABLED, true),
  echoMinSimilarity: parseFloatNumber(process.env.SYNAPSE_ECHO_MIN_SIMILARITY, 0.7),
  ledgerEnabled: parseBoolean(process.env.SYNAPSE_LEDGER_ENABLED, true),
  ledgerCommitIntervalMs: parseInteger(process.env.SYNAPSE_LEDGER_COMMIT_INTERVAL_MS, 60_000),
  watchdogEnabled: parseBoolean(process.env.SYNAPSE_WATCHDOG_ENABLED, true),
  watchdogPatrolIntervalMs: parseInteger(process.env.SYNAPSE_WATCHDOG_PATROL_INTERVAL_MS, 120_000),
  watchdogStallMs: parseInteger(process.env.SYNAPSE_WATCHDOG_STALL_MS, 300_000),
  watchdogZombieMs: parseInteger(process.env.SYNAPSE_WATCHDOG_ZOMBIE_MS, 900_000),
};

export type SynapseConfigShape = typeof SynapseConfig;
