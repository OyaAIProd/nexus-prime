import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { openArchitectsDb } from '../db/client.js';
import type { ArchitectsDb } from '../types.js';

export function createTempRepo(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(root, 'README.md'), '# Fixture\n', 'utf8');
  execSync('git init -b main', { cwd: root, stdio: 'ignore' });
  execSync('git config user.name "Nexus Prime Test"', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email "nexus-prime@test.local"', { cwd: root, stdio: 'ignore' });
  execSync('git add README.md', { cwd: root, stdio: 'ignore' });
  execSync('git commit -m "fixture"', { cwd: root, stdio: 'ignore' });
  return root;
}

export function createArchitectsDb(root = createTempRepo('nexus-architects-')): { root: string; db: ArchitectsDb } {
  return { root, db: openArchitectsDb(root) };
}

export function createArchitectsProviders(root: string) {
  return {
    repoRoot: root,
    workflowRuntime: {
      getArtifact(workflowId: string) {
        if (workflowId !== 'wf-1') return null;
        return {
          workflowId: 'wf-1',
          name: 'Ship workflow',
          steps: [
            { title: 'Prepare {{module}} branch' },
            { title: 'Verify {{module}} changes' },
          ],
        };
      },
      findByName() {
        return null;
      },
    },
    hookRuntime: {
      resolveHookSelectors() {
        return [];
      },
      dispatch() {
        return { events: [] };
      },
    },
    ledger: {
      record() {
        return undefined;
      },
      recover() {
        return [];
      },
    },
    relay: {
      async publish() {
        return { ok: true };
      },
    },
  } as any;
}

export function parseToolResult(result: any) {
  assert.ok(result?.content?.[0]?.text, 'tool result should contain serialized JSON text');
  return JSON.parse(result.content[0].text);
}
