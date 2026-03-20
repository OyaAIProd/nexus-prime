import { SkillRuntime, SkillArtifact } from './skill-runtime.js';
import { slugify } from './runtime-assets.js';
import type { InstructionPacket, ExecutionLedger } from './instruction-gateway.js';

export class SkillLearnerEngine {
    constructor(private skillRuntime: SkillRuntime) {}

    public analyzeRun(ledger: ExecutionLedger, packet: InstructionPacket): void {
        const runtimeStep = ledger.steps.find((s) => s.id === 'runtime-execution');
        if (!runtimeStep || runtimeStep.status === 'pending') return;

        const outcomeDecided = runtimeStep.status === 'completed' || runtimeStep.status === 'failed';
        if (!outcomeDecided) return;

        const runState = runtimeStep.details?.state as string | undefined;
        // Consider 'merged' or 'completed' as success. In our runtime, 'merged' means verified + patched.
        const success = runState === 'merged' || runtimeStep.status === 'completed';

        // Extract skills used in this run
        const usedSkills = packet.selectedSkills || [];

        // 1. Record outcome for injected skills
        for (const skill of usedSkills) {
            const verificationPassed = runtimeStep.details?.verifiedWorkers 
                ? Number(runtimeStep.details.verifiedWorkers) > 0 
                : false;
                
            this.skillRuntime.recordOutcome(skill.id, {
                success,
                tokenDelta: 0,
                retriesAvoided: success ? 1 : 0,
                verificationPassed,
            });
        }

        // 2. Derive new skill patterns from a successful run
        if (success) {
            this.skillRuntime.deriveFromSignals({
                goal: ledger.task,
                workerCount: 1, // Default, since the specific run worker count is in runtime results
                repeatedFailures: 0
            });
        }
    }
}
