/**
 * Memory Bridge — OpenClaw/Antigravity Memory Synchronization
 *
 * Provides bidirectional memory sync between Nexus Prime and OpenClaw/Antigravity instances.
 * Uses the existing exportBundle/importBundle methods to serialize memory state.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MemoryEngine, type MemoryExportBundle } from './memory.js';

export interface MemoryBridgeConfig {
    memoryBridgeDir?: string;
    autoSync?: boolean;
}

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

    syncTo(targetDir: string, options?: { scope?: 'session' | 'project' | 'user' | 'promoted' | 'shared' }): { success: boolean; itemCount: number; path: string } {
        try {
            const bundle = this.memoryEngine.exportBundle({ scope: options?.scope });
            const targetPath = path.join(targetDir, `nexus-memory-${Date.now()}.json`);
            
            fs.writeFileSync(targetPath, JSON.stringify(bundle, null, 2), 'utf-8');
            this.updateSyncState('export', targetPath, bundle.items.length);
            
            return {
                success: true,
                itemCount: bundle.items.length,
                path: targetPath,
            };
        } catch (error) {
            return {
                success: false,
                itemCount: 0,
                path: '',
            };
        }
    }

    syncFrom(sourceDir: string): { success: boolean; itemCount: number; errors: string[] } {
        const errors: string[] = [];
        
        try {
            if (!fs.existsSync(sourceDir)) {
                return { success: false, itemCount: 0, errors: ['Source directory does not exist'] };
            }

            const files = fs.readdirSync(sourceDir)
                .filter(f => f.startsWith('nexus-memory-') && f.endsWith('.json'))
                .sort()
                .reverse();

            if (files.length === 0) {
                return { success: true, itemCount: 0, errors: [] };
            }

            const latestFile = path.join(sourceDir, files[0]);
            const content = fs.readFileSync(latestFile, 'utf-8');
            const bundle: MemoryExportBundle = JSON.parse(content);

            if (!bundle.items || !Array.isArray(bundle.items)) {
                return { success: false, itemCount: 0, errors: ['Invalid bundle format'] };
            }

            const result = this.memoryEngine.importBundle({ bundle });
            this.updateSyncState('import', latestFile, result.imported);
            
            return {
                success: true,
                itemCount: result.imported,
                errors,
            };
        } catch (error) {
            errors.push(String(error));
            return {
                success: false,
                itemCount: 0,
                errors,
            };
        }
    }

    private updateSyncState(direction: 'export' | 'import', path: string, count: number): void {
        const state = this.loadSyncState();
        state.lastSync = Date.now();
        state.lastDirection = direction;
        state.lastPath = path;
        state.lastItemCount = count;
        
        fs.writeFileSync(this.syncStatePath, JSON.stringify(state, null, 2), 'utf-8');
    }

    private loadSyncState(): { lastSync: number; lastDirection: string; lastPath: string; lastItemCount: number } {
        try {
            if (fs.existsSync(this.syncStatePath)) {
                return JSON.parse(fs.readFileSync(this.syncStatePath, 'utf-8'));
            }
        } catch { /* corrupt sync state, return defaults */ }
        
        return {
            lastSync: 0,
            lastDirection: '',
            lastPath: '',
            lastItemCount: 0,
        };
    }

    getSyncState(): { lastSync: number; lastDirection: string; lastPath: string; lastItemCount: number } {
        return this.loadSyncState();
    }
}
