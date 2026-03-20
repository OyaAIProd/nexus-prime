import test from 'node:test';
import { ok, deepEqual, equal } from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PersistentWorkLedger } from '../src/engines/work-ledger.js';

test('PersistentWorkLedger - Git-backed crash recovery', async (t) => {
    // Setup temporary directory for test ledger
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ledger-test-'));
    let ledger: PersistentWorkLedger;

    await t.test('Initialization', () => {
        ledger = new PersistentWorkLedger(testDir);
        ok(fs.existsSync(path.join(testDir, '.git')), 'Git repository should be initialized');
    });

    await t.test('Recording and Recovering state', () => {
        const runId = 'test-run-123';
        const sampleState = { status: 'in-progress', step: 2, data: 'foo' };
        
        ledger.record(runId, sampleState, 'Step 2 update');
        
        // Inspect fs
        ok(fs.existsSync(path.join(testDir, `${runId}.json`)), 'State JSON should be created');
        
        // Recover
        const entry = ledger.recover(runId);
        ok(entry, 'Should recover an entry');
        deepEqual(entry.state, sampleState, 'Recovered state should match original');
        equal(entry.runId, runId, 'Run ID should match');
        
        // Check commit hash
        const hash = ledger.getLatestCommitHash(runId);
        ok(hash && typeof hash === 'string' && hash.length === 40, 'Should return a valid git hash: ' + hash);
    });

    await t.test('Multiple runs list properly', () => {
        ledger.record('run-a', { id: 1 });
        ledger.record('run-b', { id: 2 });
        ledger.record('run-c', { id: 3 });

        const runs = ledger.listRuns();
        ok(runs.includes('run-a'), 'Lists run-a');
        ok(runs.includes('run-b'), 'Lists run-b');
        ok(runs.includes('test-run-123'), 'Lists previous test runs');
    });

    await t.test('Cleanup', () => {
        // Remove tmp dir
        fs.rmSync(testDir, { recursive: true, force: true });
    });
});
