import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { resolveNexusStateDir } from './runtime-registry.js';

export interface LedgerEntry {
    runId: string;
    timestamp: number;
    state: any;
}

/**
 * Persistent Work Ledger
 * 
 * Provides crash recovery by backing execution state into a local Git repository.
 * Every significant state change is written to a JSON file and committed,
 * allowing the system to robustly recover from unexpected failures and
 * preserving a complete history of the execution steps.
 */
export class PersistentWorkLedger {
    private ledgerDir: string;
    
    constructor(baseDir?: string) {
        this.ledgerDir = baseDir || path.join(resolveNexusStateDir(), 'ledger');
        this.initGit();
    }
    
    private initGit() {
        if (!fs.existsSync(this.ledgerDir)) {
            fs.mkdirSync(this.ledgerDir, { recursive: true });
        }
        
        const gitDir = path.join(this.ledgerDir, '.git');
        if (!fs.existsSync(gitDir)) {
            this.execGit('init');
            this.execGit('config user.name "Nexus Prime"');
            this.execGit('config user.email "nexus@prime.local"');
        }
    }
    
    private execGit(command: string): string {
        try {
            return execSync(`git -C "${this.ledgerDir}" ${command}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        } catch (err) {
            // It's acceptable for git commit to fail if there's nothing to commit
            if (!command.startsWith('commit')) {
                console.error(`[WorkLedger] Git error on command '${command}':`, err);
            }
            return '';
        }
    }
    
    /**
     * Records the current state for a run and commits it to the ledger.
     */
    public record(runId: string, state: any, message: string = `Update state for ${runId}`): void {
        const filePath = path.join(this.ledgerDir, `${runId}.json`);
        const entry: LedgerEntry = {
            runId,
            timestamp: Date.now(),
            state
        };
        
        fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));
        
        this.execGit(`add "${runId}.json"`);
        // Git commit will fail if there are no semantic changes, which is fine
        const sanitized = message.replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
        this.execGit(`commit -m "${sanitized}"`);
    }
    
    /**
     * Recover the latest saved state for a given run ID.
     */
    public recover(runId: string): LedgerEntry | null {
        const filePath = path.join(this.ledgerDir, `${runId}.json`);
        if (!fs.existsSync(filePath)) {
            return null;
        }
        
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(content) as LedgerEntry;
        } catch (err) {
            console.error(`[WorkLedger] Failed to recover run ${runId}:`, err);
            return null;
        }
    }
    
    /**
     * List all available runs in the ledger.
     */
    public listRuns(): string[] {
        if (!fs.existsSync(this.ledgerDir)) return [];
        return fs.readdirSync(this.ledgerDir)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace('.json', ''));
    }

    /**
     * Gets the git commit hash for the latest change to a specific run.
     */
    public getLatestCommitHash(runId: string): string | null {
        const hash = this.execGit(`log -1 --format="%H" -- "${runId}.json"`);
        return hash ? hash : null;
    }
}
