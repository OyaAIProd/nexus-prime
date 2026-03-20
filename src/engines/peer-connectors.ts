import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

export interface PeerProfile {
    id: string;
    configPath: string;
    detected: boolean;
    capabilities: string[];
    lastSeen: number;
}

/**
 * Scans standard paths in the user's home directory to dynamically
 * discover peer AI agent ecosystems like OpenClaw, Hermes, PicoClaw, or Atlas.
 *
 * @returns Array of detected peer profiles
 */
export async function detectAllPeers(): Promise<PeerProfile[]> {
    const home = os.homedir();
    const peers: PeerProfile[] = [];

    const candidates = [
        { id: 'openclaw', relativeConfig: '.openclaw/openclaw.json' },
        { id: 'hermes', relativeConfig: '.hermes/config.yaml' },
        { id: 'picoclaw', relativeConfig: '.picoclaw/config.yaml' },
        { id: 'opencode', relativeConfig: '.config/opencode/opencode.json' },
        { id: 'atlas', relativeConfig: '.goatlas/config.json' }
    ];

    for (const c of candidates) {
        const fullPath = path.join(home, c.relativeConfig);
        try {
            if (fs.existsSync(fullPath)) {
                const capabilities = c.id === 'atlas'
                    ? ['code-intelligence', 'ast-parsing', 'semantic-search', 'impact-analysis', 'tool-relay']
                    : ['skill-sharing', 'memory-sync', 'tool-relay'];
                peers.push({
                    id: c.id,
                    configPath: fullPath,
                    detected: true,
                    capabilities,
                    lastSeen: Date.now()
                });
            }
        } catch (err) {
            // Silently ignore stat errors since these are external
        }
    }

    // Binary detection fallback for Atlas code intelligence peer
    if (!peers.find(p => p.id === 'atlas')) {
        try {
            execSync('which goatlas', { stdio: 'ignore', timeout: 2000 });
            peers.push({
                id: 'atlas',
                configPath: '',
                detected: true,
                capabilities: ['code-intelligence', 'ast-parsing', 'semantic-search', 'impact-analysis', 'tool-relay'],
                lastSeen: Date.now()
            });
        } catch {
            // Atlas not installed — skip silently
        }
    }

    return peers;
}
