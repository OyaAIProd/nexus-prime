import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SECRET_PATTERNS } from '../src/engines/security-shield.js';
import { MemoryEngine } from '../src/engines/memory.js';

function createSandbox(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return {
    root,
    dbPath: path.join(root, 'memory.db'),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const fixtures = [
  `OPENAI_API_KEY=${'sk-' + 'ABCD1234EFGH5678IJKL9012MNOP3456'}`,
  `sk-${'ant'}-${'ABCDEFGHIJKLMNOPQRSTUV-abcdefghijklmnop'}`,
  `AKIA${'1234567890ABCDEF'}`,
  'aws_secret_access_key = supersecretvalue123456',
  `${'ghp'}_${'abcdefghijklmnopqrstuvwxyz1234567890'}`,
  `${'github'}_${'pat'}_${'abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789'}`,
  `${'gho'}_${'abcdefghijklmnopqrstuvwxyz1234567890'}`,
  `${'xoxb'}-${'1234567890-ABCDEFGHIJ-klmnopqrst'}`,
  `${'sk'}_${'live'}_${'1234567890abcdefghijklmnop'}`,
  `${'sk'}_${'test'}_${'1234567890abcdefghijklmnop'}`,
  `Bearer ${'abcdefghijklmnopqrstuvwxyz0123456789._-~+/'}`,
  'SERVICE_TOKEN=supersecrettokenvalue',
  `apiKey="${'0123456789abcdef0123456789abcdef'}"`,
];

test('SECRET_PATTERNS catches the expanded secret suite', () => {
  for (const fixture of fixtures) {
    ok(
      SECRET_PATTERNS.some((pattern) => pattern.test(fixture)),
      `expected at least one pattern to match ${fixture}`,
    );
  }
});

test('MemoryEngine blocks secret-bearing content through canonical shield patterns', () => {
  const sandbox = createSandbox('nexus-security-shield');
  const memory = new MemoryEngine(sandbox.dbPath);

  const check = memory.checkContent(`OPENAI_API_KEY=${'sk-' + 'ABCD1234EFGH5678IJKL9012MNOP3456'}`, {
    tags: ['#security'],
    priority: 0.95,
  });

  equal(check.action, 'block');

  memory.close();
  sandbox.cleanup();
});
