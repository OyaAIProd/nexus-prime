import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { openSynapseDb } from '../db/client.js';
import type { SynapseDb } from '../types.js';

export function createTempRepo(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(root, 'README.md'), '# Fixture\n', 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true }, null, 2), 'utf8');
  execSync('git init -b main', { cwd: root, stdio: 'ignore' });
  execSync('git config user.name "Nexus Prime Test"', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email "nexus-prime@test.local"', { cwd: root, stdio: 'ignore' });
  execSync('git add README.md package.json', { cwd: root, stdio: 'ignore' });
  execSync('git commit -m "fixture"', { cwd: root, stdio: 'ignore' });
  return root;
}

export function createSynapseDb(root = createTempRepo('nexus-synapse-')): { root: string; db: SynapseDb } {
  return { root, db: openSynapseDb(root) };
}

export function createMemoryStub(recallHits: string[] = []) {
  const storeCalls: Array<{ content: string; priority: number; tags: string[] }> = [];
  const recallCalls: Array<{ query: string; limit: number }> = [];
  return {
    storeCalls,
    recallCalls,
    store(content: string, priority: number, tags: string[]) {
      storeCalls.push({ content, priority, tags });
      return `memory-${storeCalls.length}`;
    },
    async recall(query: string, limit: number) {
      recallCalls.push({ query, limit });
      return recallHits.slice(0, limit);
    },
  };
}

export function createSkillRuntimeStub(skills: Array<Record<string, any>> = []) {
  return {
    listArtifacts() {
      return skills;
    },
  };
}

export function parseToolResult(result: any) {
  assert.ok(result?.content?.[0]?.text, 'tool result should contain serialized JSON text');
  return JSON.parse(result.content[0].text);
}
