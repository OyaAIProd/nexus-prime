import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

function createFixtureRepo(prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Control Plane Fixture\n', 'utf8');
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({
      name: 'nexus-prime-control-plane-fixture',
      version: '1.0.0',
      private: true,
      scripts: {
        build: 'node -e "process.exit(0)"',
      },
    }, null, 2),
    'utf8',
  );
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const fixture = true;\n', 'utf8');

  execSync('git init -b main', { cwd: repoRoot, stdio: 'ignore' });
  execSync('git config user.name "Nexus Prime Control Plane Test"', { cwd: repoRoot, stdio: 'ignore' });
  execSync('git config user.email "nexus-prime-control-plane@test.local"', { cwd: repoRoot, stdio: 'ignore' });
  execSync('git add README.md package.json src/app.ts', { cwd: repoRoot, stdio: 'ignore' });
  execSync('git commit -m "fixture"', { cwd: repoRoot, stdio: 'ignore' });
  return repoRoot;
}

test('NexusPrime bootstraps Synapse and Architects through the explicit control-plane bridge', async () => {
  const originalCwd = process.cwd();
  const originalEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
    NEXUS_MEMORY_DB_PATH: process.env.NEXUS_MEMORY_DB_PATH,
    NEXUS_STATE_DIR: process.env.NEXUS_STATE_DIR,
    NEXUS_POD_PATH: process.env.NEXUS_POD_PATH,
    NEXUS_DASHBOARD_DISABLED: process.env.NEXUS_DASHBOARD_DISABLED,
  };
  const repoRoot = createFixtureRepo('nexus-prime-control-plane');
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-prime-control-plane-state-'));

  process.env.HOME = path.join(stateRoot, '.home');
  process.env.USERPROFILE = process.env.HOME;
  process.env.CODEX_HOME = path.join(stateRoot, '.codex');
  process.env.NEXUS_MEMORY_DB_PATH = path.join(stateRoot, 'memory.db');
  process.env.NEXUS_STATE_DIR = path.join(stateRoot, '.nexus-state');
  process.env.NEXUS_POD_PATH = path.join(stateRoot, '.nexus-pod.json');
  process.env.NEXUS_DASHBOARD_DISABLED = '1';
  fs.mkdirSync(process.env.HOME, { recursive: true });
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });

  process.chdir(repoRoot);

  const { createNexusPrime } = await import('../src/index.js');
  const { podNetwork } = await import('../src/engines/pod-network.js');
  const nexus = createNexusPrime({ adapters: [] });
  await nexus.start();

  try {
    const synapse = nexus.getSynapse();
    const architects = nexus.getArchitects();
    ok(synapse, 'synapse runtime should be available');
    ok(architects, 'architects runtime should be available');

    nexus.getOrchestrator().orchestrate = async (goal: string) => ({
      runId: 'run-control-plane',
      state: 'merged',
      result: goal,
      workerResults: [
        {
          learnings: ['control-plane coordination verified'],
          modifiedFiles: ['src/app.ts'],
          outcome: 'ok',
        },
      ],
      tokenTelemetry: { forwardedTokens: 420 },
    }) as any;

    const team = await synapse!.executeMandatePipeline(
      'Review and harden the dashboard UI UX, frontend backend API bindings, Synapse and Architects coordination, and fix lag across the control plane.',
      { maxOperatives: 1, budgetUsd: 5 },
    );

    const worklistId = architects!.getWorklistForStrikeTeam(team.id);
    ok(worklistId, 'architects should expose the implicit worklist for the deployed strike team');

    const initialWorklist = architects!.getWorklist(worklistId!);
    ok(initialWorklist.items.length >= 1, 'the deployed mandate should create at least one work item on the implicit worklist');

    const operative = (synapse!.getOperativeHealth() as any[])[0];
    ok(operative?.missionId, 'the operative should have a mission assigned before running the sortie');
    ok(
      initialWorklist.items.some((item) => item.id === operative.missionId),
      'the assigned mission should be represented on the Architects worklist',
    );
    const sortie = await synapse!.runSortie(operative.id);
    equal(sortie.status, 'completed', 'sortie should complete through the bootstrapped coordination bridge');

    const updatedWorklist = architects!.getWorklist(worklistId!);
    const completedItem = updatedWorklist.items.find((item) => item.id === operative.missionId);
    ok(completedItem, 'the sortie should target a matching Architects work item');
    equal(completedItem.status, 'done', 'architects should complete the work item matching the operative mission');

    const convergence = await architects!.runConvergenceQueue(worklistId!);
    equal(convergence.status, 'merged', 'convergence should complete on the normal bootstrap path');

    const sentinel = await architects!.getSentinelReport(team.id);
    ok(['healthy', 'degraded', 'critical'].includes(sentinel.overallHealth), 'sentinel should return a valid health report');

    const podSnapshot = podNetwork.getDashboardSnapshot(20);
    ok(
      podSnapshot.messages.some((message) =>
        message.tags.includes(`#team:${team.id}`) &&
        message.tags.some((tag) => tag.startsWith('#workitem:')) &&
        message.tags.some((tag) => tag.startsWith('#corr:')),
      ),
      'coordination bridge should publish correlated POD telemetry for dashboard inspection',
    );
  } finally {
    await nexus.stop();
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
