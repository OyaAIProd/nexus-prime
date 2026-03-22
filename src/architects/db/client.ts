import fs from 'fs';
import path from 'path';
import BetterSqlite3 from 'better-sqlite3';
import { initArchitectsSchema } from './schema.js';
import type { ArchitectsDb } from '../types.js';

export function resolveArchitectsPaths(root: string = process.cwd()): { dir: string; dbPath: string } {
  const dir = path.join(root, '.architects');
  return {
    dir,
    dbPath: path.join(dir, 'architects.db'),
  };
}

export function openArchitectsDb(root: string = process.cwd()): ArchitectsDb {
  const paths = resolveArchitectsPaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  const db = new BetterSqlite3(paths.dbPath) as ArchitectsDb;
  initArchitectsSchema(db);
  return db;
}
