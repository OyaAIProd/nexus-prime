import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MemoryEngine } from '../src/engines/memory.js';
import { MemoryBridge } from '../src/engines/memory-bridge.js';

function createSandbox(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return {
    root,
    dbPath: path.join(root, 'memory.db'),
    exportDir: path.join(root, 'exports'),
    bridgeDir: path.join(root, 'bridge'),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('MemoryBridge writes chunked manifests and imports them with diff-aware results', () => {
  const source = createSandbox('nexus-memory-bridge-source');
  const target = createSandbox('nexus-memory-bridge-target');
  fs.mkdirSync(source.exportDir, { recursive: true });

  const sourceMemory = new MemoryEngine(source.dbPath);
  const targetMemory = new MemoryEngine(target.dbPath);

  sourceMemory.store('Bridge export fact one', 0.9, ['#bridge']);
  sourceMemory.store('Bridge export fact two', 0.85, ['#bridge']);

  const sourceBridge = new MemoryBridge(sourceMemory, { memoryBridgeDir: source.bridgeDir });
  const syncTo = sourceBridge.syncTo(source.exportDir, { scope: 'session', chunkSize: 1 });
  ok(syncTo.success);
  ok(syncTo.manifestPath);
  equal(syncTo.chunkCount, 2);
  ok(fs.existsSync(syncTo.manifestPath!));

  const manifest = JSON.parse(fs.readFileSync(syncTo.manifestPath!, 'utf8')) as { chunkCount: number; chunks: Array<{ file: string }> };
  equal(manifest.chunkCount, 2);
  ok(manifest.chunks.every((chunk) => fs.existsSync(path.join(syncTo.path, chunk.file))));

  const targetBridge = new MemoryBridge(targetMemory, { memoryBridgeDir: target.bridgeDir });
  const firstImport = targetBridge.syncFrom(source.exportDir);
  ok(firstImport.success);
  equal(firstImport.added, 2);
  equal(firstImport.updated, 0);
  equal(firstImport.skipped, 0);

  const secondImport = targetBridge.syncFrom(source.exportDir);
  ok(secondImport.success);
  equal(secondImport.added, 0);
  equal(secondImport.updated, 0);
  equal(secondImport.skipped, 2);

  const state = targetBridge.getSyncState();
  equal(state.lastSkipped, 2);
  ok(state.manifestPath);

  targetMemory.close();
  sourceMemory.close();
  target.cleanup();
  source.cleanup();
});
