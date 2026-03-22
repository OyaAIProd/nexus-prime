/**
 * Nexus Prime - Darwin Loop Orchestrator
 *
 * Enforces controlled self-improvement via bounded modification spaces.
 * Ensures proposed hypotheses target allowed directories before logging them.
 *
 * Phase: 8F (Darwin Loop)
 */

import { DarwinJournal, type DarwinCycle } from './darwin-journal.js';
import type { MemoryEngine } from './memory.js';
import { nexusEventBus } from './event-bus.js';

// ─────────────────────────────────────────────────────────────────────────────
// Bounded Improvement Space Config
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_PATHS = [
    'src/engines/',
    'src/phantom/'
];

const FORBIDDEN_PATHS = [
    'src/agents/adapters/mcp.ts',
    'src/cli.ts',
    'src/index.ts',
    'package.json',
    'tsconfig.json'
];

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export class DarwinLoop {
    public journal: DarwinJournal;
    private memory?: MemoryEngine;

    constructor(memory?: MemoryEngine) {
        this.journal = new DarwinJournal();
        this.memory = memory;
    }

    /**
     * Determine if a target file is within the bounded improvement space.
     */
    isAllowedTarget(targetFile: string): { allowed: boolean; reason?: string } {
        // Normalize path separators
        const normalized = targetFile.replace(/\\/g, '/');

        // Check forbidden explicitly
        for (const f of FORBIDDEN_PATHS) {
            if (normalized === f || normalized.endsWith(`/${f}`)) {
                return { allowed: false, reason: `Path explicitly forbidden by core safety bounds: ${f}` };
            }
        }

        // Check allowed prefixes
        for (const a of ALLOWED_PATHS) {
            if (normalized.includes(a)) {
                return { allowed: true };
            }
        }

        return { allowed: false, reason: 'Path is outside of ALLOWED structural bounds (must be engines/ or phantom/)' };
    }

    /**
     * Propose an improvement hypothesis if bounds check passes.
     */
    propose(hypothesis: string, targetFile: string, approach: string): DarwinCycle {
        const boundsCheck = this.isAllowedTarget(targetFile);
        if (!boundsCheck.allowed) {
            throw new Error(`[Darwin Loop Rejected Proposal]: ${boundsCheck.reason}`);
        }

        // Forward to journal
        return this.journal.propose(hypothesis, targetFile, approach);
    }

    /**
     * Run a build step to validate the code still compiles.
     */
    async validateBuild(): Promise<void> {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        try {
            await execAsync('npm run build', { cwd: process.cwd() });
        } catch (error: any) {
            throw new Error(`Build validation failed:\n${error.stdout || error.message}`);
        }
    }

    /**
     * Review a pending cycle. Evaluates builds before allowing 'apply'.
     */
    async review(cycleId: string, action: 'apply' | 'reject' | 'defer', learnings: string[] = []): Promise<DarwinCycle> {
        const cycle = this.journal.getCycle(cycleId);
        if (!cycle) {
            throw new Error(`Darwin Cycle ${cycleId} not found.`);
        }

        if (cycle.outcome !== 'pending') {
            throw new Error(`Darwin Cycle ${cycleId} is already ${cycle.outcome}.`);
        }

        if (action === 'apply') {
            // Before applying, validate that the build succeeds
            await this.validateBuild();
        }

        // Update state
        const outcomeMap: Record<string, DarwinCycle['outcome']> = {
            'apply': 'applied',
            'reject': 'rejected',
            'defer': 'deferred'
        };

        const updated = this.journal.updateCycle(cycleId, {
            outcome: outcomeMap[action],
            learnings
        });

        if (updated && (updated.outcome === 'applied' || updated.outcome === 'rejected')) {
            const fitnessDelta = (updated.metricsAfter?.fitness ?? 0) - (updated.metricsBefore?.fitness ?? 0);
            const content = [
                `Darwin cycle ${updated.id}: hypothesis "${updated.hypothesis}"`,
                `Target: ${updated.targetFile}. Outcome: ${updated.outcome}.`,
                `Build: ${updated.buildPassed ? 'PASS' : 'FAIL'}, Tests: ${updated.testsPassed ? 'PASS' : 'FAIL'}.`,
                `Fitness delta: ${fitnessDelta}.`,
                updated.learnings.length ? `Learnings: ${updated.learnings.join('; ')}` : '',
            ].filter(Boolean).join(' ');

            this.memory?.store(
                content,
                0.5,
                ['#darwin', `#darwin:${updated.outcome}`, `#target:${updated.targetFile}`],
                undefined,
                0,
                {
                    tier: 'cortex',
                    state: 'active',
                    trust: updated.outcome === 'applied' ? 0.9 : 0.6,
                    source: 'system',
                    provenance: {
                        source: 'runtime',
                        summary: 'Darwin cycle outcome',
                        tags: ['#darwin'],
                    },
                },
            );
            nexusEventBus.emit('darwin.cycle.complete', {
                id: updated.id,
                outcome: updated.outcome,
                targetFile: updated.targetFile,
            });
        }

        return updated!;
    }

    /**
     * Get pending cycles
     */
    getPending(): DarwinCycle[] {
        return this.journal.getPending();
    }
}
