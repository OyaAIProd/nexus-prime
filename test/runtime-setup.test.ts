import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runRuntimeSetup } from '../src/cli-setup.js';

async function test() {
  console.log('🧪 Testing runtime setup idempotency...\n');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-prime-runtime-setup-'));
  fs.writeFileSync(path.join(root, '.env.example'), '# env\n', 'utf8');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n', 'utf8');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# AGENTS.md\n', 'utf8');
  fs.writeFileSync(path.join(root, 'Claude.md'), '# Claude\n', 'utf8');

  await runRuntimeSetup('all', root);
  await runRuntimeSetup('all', root);

  assert.ok(fs.existsSync(path.join(root, '.synapse', 'synapse.db')), 'setup should initialize the Synapse database');
  assert.ok(fs.existsSync(path.join(root, '.architects', 'architects.db')), 'setup should initialize the Architects database');

  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  const claude = fs.readFileSync(path.join(root, 'Claude.md'), 'utf8');

  assert.strictEqual((envExample.match(/# nexus-prime:v5-runtime:start/g) || []).length, 1, 'runtime env block should be injected once');
  assert.strictEqual((gitignore.match(/# nexus-prime:v5-runtime:start/g) || []).length, 1, 'runtime gitignore block should be injected once');
  assert.strictEqual((agents.match(/<!-- nexus-prime:synapse:start -->/g) || []).length, 1, 'Synapse AGENTS block should be injected once');
  assert.strictEqual((agents.match(/<!-- nexus-prime:architects:start -->/g) || []).length, 1, 'Architects AGENTS block should be injected once');
  assert.strictEqual((claude.match(/<!-- nexus-prime:synapse:start -->/g) || []).length, 1, 'Synapse Claude block should be injected once');
  assert.strictEqual((claude.match(/<!-- nexus-prime:architects:start -->/g) || []).length, 1, 'Architects Claude block should be injected once');

  console.log('✅ Runtime setup idempotency passed');
}

void test();
