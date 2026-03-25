import * as fs from 'fs';
import * as path from 'path';
import { resolveNexusStateDir } from './runtime-registry.js';

export interface LifetimeTokenRecord {
  totalSavedTokens: number;
  totalGrossInputTokens: number;
  totalCompressedTokens: number;
  totalRuns: number;
  lastUpdatedAt: number;
}

const LIFETIME_FILE = 'lifetime-tokens.json';

export function readLifetimeTokens(stateDir?: string): LifetimeTokenRecord {
  const filePath = path.join(stateDir ?? resolveNexusStateDir(), LIFETIME_FILE);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as LifetimeTokenRecord;
    }
  } catch { /* ignore */ }
  return {
    totalSavedTokens: 0,
    totalGrossInputTokens: 0,
    totalCompressedTokens: 0,
    totalRuns: 0,
    lastUpdatedAt: Date.now(),
  };
}

export function accumulateLifetimeTokens(
  delta: { savedTokens: number; grossInputTokens: number; compressedTokens: number },
  stateDir?: string,
): LifetimeTokenRecord {
  const filePath = path.join(stateDir ?? resolveNexusStateDir(), LIFETIME_FILE);
  const current = readLifetimeTokens(stateDir);
  const updated: LifetimeTokenRecord = {
    totalSavedTokens: current.totalSavedTokens + (delta.savedTokens ?? 0),
    totalGrossInputTokens: current.totalGrossInputTokens + (delta.grossInputTokens ?? 0),
    totalCompressedTokens: current.totalCompressedTokens + (delta.compressedTokens ?? 0),
    totalRuns: current.totalRuns + 1,
    lastUpdatedAt: Date.now(),
  };
  try {
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf8');
  } catch { /* non-critical */ }
  return updated;
}
