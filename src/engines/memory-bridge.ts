/**
 * Memory Bridge — OpenClaw/Antigravity Memory Synchronization
 *
 * Provides bidirectional memory sync between Nexus Prime and external agent instances.
 * Uses chunked manifest exports by default while remaining backward compatible with
 * the older single-file bundle format.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    MemoryEngine,
    type MemoryExportBundle,
    type MemoryExportOrigin,
    type MemoryImportResult,
} from './memory.js';

export interface MemoryBridgeConfig {
    memoryBridgeDir?: string;
    autoSync?: boolean;
}

export interface MemoryBridgeExportManifest {
    formatVersion: number;
    exportedAt: number;
    scope?: 'session' | 'project' | 'user' | 'promoted' | 'shared';
    bundleVersion: number;
    schemaVersion?: string;
    origin?: MemoryExportOrigin;
    itemCount: number;
    chunkCount: number;
    chunks: Array<{ file: string; itemCount: number }>;
}

export interface MemoryBridgeSyncState {
    lastSync: number;
    lastDirection: string;
    lastPath: string;
    lastItemCount: number;
    lastAdded: number;
    lastUpdated: number;
    lastSkipped: number;
    lastQuarantined: number;
    manifestPath?: string;
}

export interface MemoryBridgeSyncToResult {
    success: boolean;
    itemCount: number;
    path: string;
    manifestPath?: string;
    chunkCount?: number;
    bundleVersion?: number;
}

export interface MemoryBridgeSyncFromResult extends MemoryImportResult {
    success: boolean;
    errors: string[];
    path?: string;
    manifestPath?: string;
}

const DEFAULT_CHUNK_SIZE = 250;

export class MemoryBridge {
    private memoryEngine: MemoryEngine;
    private bridgeDir: string;
    private syncStatePath: string;

    constructor(memoryEngine: MemoryEngine, config?: MemoryBridgeConfig) {
        this.memoryEngine = memoryEngine;
        this.bridgeDir = config?.memoryBridgeDir ?? path.join(os.homedir(), '.antigravity', 'nexus-prime');
        this.syncStatePath = path.join(this.bridgeDir, 'memory-sync.json');

        fs.mkdirSync(this.bridgeDir, { recursive: true });
    }

    getBridgeDir(): string {
        return this.bridgeDir;
    }

    syncTo(
        targetDir: string,
        options?: { scope?: 'session' | 'project' | 'user' | 'promoted' | 'shared'; chunkSize?: number },
    ): MemoryBridgeSyncToResult {
        try {
            const bundle = this.memoryEngine.exportBundle({ scope: options?.scope });
            const exportDir = path.join(targetDir, `nexus-memory-${bundle.exportedAt}`);
            const chunksDir = path.join(exportDir, 'chunks');
            fs.mkdirSync(chunksDir, { recursive: true });

            const chunkSize = Math.max(1, options?.chunkSize ?? DEFAULT_CHUNK_SIZE);
            const chunkFiles = chunkArray(bundle.items, chunkSize).map((items, index) => {
                const file = `chunk-${String(index + 1).padStart(3, '0')}.json`;
                fs.writeFileSync(path.join(chunksDir, file), JSON.stringify({ items }, null, 2), 'utf-8');
                return { file: path.join('chunks', file), itemCount: items.length };
            });

            const manifest: MemoryBridgeExportManifest = {
                formatVersion: 1,
                exportedAt: bundle.exportedAt,
                scope: options?.scope,
                bundleVersion: bundle.version,
                schemaVersion: bundle.schemaVersion,
                origin: bundle.origin,
                itemCount: bundle.items.length,
                chunkCount: chunkFiles.length,
                chunks: chunkFiles,
            };

            const manifestPath = path.join(exportDir, 'manifest.json');
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
            fs.writeFileSync(path.join(exportDir, 'bundle.json'), JSON.stringify(bundle, null, 2), 'utf-8');

            this.updateSyncState('export', exportDir, {
                itemCount: bundle.items.length,
                manifestPath,
                added: 0,
                updated: 0,
                skipped: 0,
                quarantined: 0,
            });

            return {
                success: true,
                itemCount: bundle.items.length,
                path: exportDir,
                manifestPath,
                chunkCount: chunkFiles.length,
                bundleVersion: bundle.version,
            };
        } catch {
            return {
                success: false,
                itemCount: 0,
                path: '',
            };
        }
    }

    syncFrom(sourceDir: string): MemoryBridgeSyncFromResult {
        const errors: string[] = [];

        try {
            if (!fs.existsSync(sourceDir)) {
                return emptyImportResult(false, ['Source directory does not exist']);
            }

            const resolved = this.resolveImportTarget(sourceDir);
            if (!resolved) {
                return emptyImportResult(true, []);
            }

            const bundle = this.loadBundle(resolved.path, resolved.manifestPath);
            if (!bundle.items || !Array.isArray(bundle.items)) {
                return emptyImportResult(false, ['Invalid bundle format']);
            }

            const result = this.memoryEngine.importBundle({ bundle });
            this.updateSyncState('import', resolved.path, {
                itemCount: result.imported,
                manifestPath: resolved.manifestPath,
                added: result.added,
                updated: result.updated,
                skipped: result.skipped,
                quarantined: result.quarantined,
            });

            return {
                success: true,
                errors,
                path: resolved.path,
                manifestPath: resolved.manifestPath,
                ...result,
            };
        } catch (error) {
            errors.push(String(error));
            return emptyImportResult(false, errors);
        }
    }

    private resolveImportTarget(sourceDir: string): { path: string; manifestPath?: string } | null {
        const manifestAtRoot = path.join(sourceDir, 'manifest.json');
        if (fs.existsSync(manifestAtRoot)) {
            return { path: sourceDir, manifestPath: manifestAtRoot };
        }

        const entries = fs.readdirSync(sourceDir, { withFileTypes: true })
            .sort((left, right) => right.name.localeCompare(left.name));

        for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith('nexus-memory-')) {
                const targetDir = path.join(sourceDir, entry.name);
                const manifestPath = path.join(targetDir, 'manifest.json');
                if (fs.existsSync(manifestPath)) {
                    return { path: targetDir, manifestPath };
                }
            }
        }

        const legacyFiles = entries
            .filter((entry) => entry.isFile() && entry.name.startsWith('nexus-memory-') && entry.name.endsWith('.json'))
            .map((entry) => path.join(sourceDir, entry.name))
            .sort()
            .reverse();

        if (legacyFiles.length > 0) {
            return { path: legacyFiles[0] };
        }

        return null;
    }

    private loadBundle(targetPath: string, manifestPath?: string): MemoryExportBundle {
        if (!manifestPath) {
            const content = fs.readFileSync(targetPath, 'utf-8');
            return JSON.parse(content) as MemoryExportBundle;
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as MemoryBridgeExportManifest;
        const items = manifest.chunks.flatMap((chunk) => {
            const chunkPath = path.join(targetPath, chunk.file);
            const parsed = JSON.parse(fs.readFileSync(chunkPath, 'utf-8')) as { items?: MemoryExportBundle['items'] };
            return Array.isArray(parsed.items) ? parsed.items : [];
        });

        return {
            version: manifest.bundleVersion,
            schemaVersion: manifest.schemaVersion,
            exportedAt: manifest.exportedAt,
            sessionId: manifest.origin?.sessionId ?? '',
            origin: manifest.origin,
            stats: this.memoryEngine.getStats(),
            health: this.memoryEngine.getHealthSummary(),
            items,
        };
    }

    private updateSyncState(
        direction: 'export' | 'import',
        targetPath: string,
        input: {
            itemCount: number;
            manifestPath?: string;
            added: number;
            updated: number;
            skipped: number;
            quarantined: number;
        },
    ): void {
        const state = this.loadSyncState();
        state.lastSync = Date.now();
        state.lastDirection = direction;
        state.lastPath = targetPath;
        state.lastItemCount = input.itemCount;
        state.lastAdded = input.added;
        state.lastUpdated = input.updated;
        state.lastSkipped = input.skipped;
        state.lastQuarantined = input.quarantined;
        state.manifestPath = input.manifestPath;

        fs.writeFileSync(this.syncStatePath, JSON.stringify(state, null, 2), 'utf-8');
    }

    private loadSyncState(): MemoryBridgeSyncState {
        try {
            if (fs.existsSync(this.syncStatePath)) {
                return JSON.parse(fs.readFileSync(this.syncStatePath, 'utf-8')) as MemoryBridgeSyncState;
            }
        } catch {
            // Corrupt sync state; fall through to defaults.
        }

        return {
            lastSync: 0,
            lastDirection: '',
            lastPath: '',
            lastItemCount: 0,
            lastAdded: 0,
            lastUpdated: 0,
            lastSkipped: 0,
            lastQuarantined: 0,
        };
    }

    getSyncState(): MemoryBridgeSyncState {
        return this.loadSyncState();
    }
}

function chunkArray<T>(items: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
        result.push(items.slice(index, index + size));
    }
    return result;
}

function emptyImportResult(success: boolean, errors: string[]): MemoryBridgeSyncFromResult {
    return {
        success,
        imported: 0,
        duplicates: 0,
        added: 0,
        updated: 0,
        skipped: 0,
        quarantined: 0,
        importedIds: [],
        errors,
    };
}
