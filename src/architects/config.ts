function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const ArchitectsConfig = {
  enabled: parseBoolean(process.env.ARCHITECTS_ENABLED, true),
  maxConcurrent: parseInteger(process.env.ARCHITECTS_MAX_CONCURRENT, -1),
  sentinelPatrolMs: parseInteger(process.env.ARCHITECTS_SENTINEL_PATROL_MS, 120_000),
  wardPatrolMs: parseInteger(process.env.ARCHITECTS_WARD_PATROL_MS, 180_000),
  convergenceStrategy: (process.env.ARCHITECTS_CONVERGENCE_STRATEGY || 'bisecting') as 'bisecting' | 'sequential',
};
