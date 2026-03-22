import fs from 'fs';
import path from 'path';
import BetterSqlite3 from 'better-sqlite3';
import { initSynapseSchema } from './schema.js';
import type { SynapseDb } from '../types.js';

export function resolveSynapsePaths(root: string = process.cwd()): { dir: string; ledgerDir: string; dbPath: string } {
  const dir = path.join(root, '.synapse');
  return {
    dir,
    ledgerDir: path.join(dir, 'ledger'),
    dbPath: path.join(dir, 'synapse.db'),
  };
}

export function openSynapseDb(root: string = process.cwd()): SynapseDb {
  const paths = resolveSynapsePaths(root);
  fs.mkdirSync(paths.ledgerDir, { recursive: true });
  const db = new BetterSqlite3(paths.dbPath) as SynapseDb;
  initSynapseSchema(db);
  return db;
}
