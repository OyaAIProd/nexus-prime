import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface PeerProfile {
    id: string;
    configPath: string;
    detected: boolean;
    capabilities: string[];
    lastSeen: number;
}

/**
 * Scans standard paths in the user's home directory to dynamically
 * discover peer AI agent ecosystems like OpenClaw, Hermes, or PicoClaw.
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
        { id: 'opencode', relativeConfig: '.config/opencode/opencode.json' }
    ];

    for (const c of candidates) {
        const fullPath = path.join(home, c.relativeConfig);
        try {
            if (fs.existsSync(fullPath)) {
                peers.push({
                    id: c.id,
                    configPath: fullPath,
                    detected: true,
                    capabilities: ['skill-sharing', 'memory-sync', 'tool-relay'],
                    lastSeen: Date.now()
                });
            }
        } catch (err) {
            // Silently ignore stat errors since these are external
        }
    }

    return peers;
}
