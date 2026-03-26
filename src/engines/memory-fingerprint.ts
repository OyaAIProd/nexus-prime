import { createHash } from 'crypto';
import type { MemoryProvenance } from './memory-control-plane.js';

export interface MemoryFingerprintContext {
    scope?: string;
    provenance?: Partial<MemoryProvenance>;
}

function normalizeContent(value: string): string {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function createMemoryContentFingerprint(
    content: string,
    context: MemoryFingerprintContext = {},
): string {
    const normalized = normalizeContent(content);
    const provenance = context.provenance ?? {};
    const parts = [
        normalized,
        String(context.scope ?? ''),
        String(provenance.repoId ?? ''),
        String(provenance.workspaceId ?? ''),
        String(provenance.projectId ?? ''),
        String(provenance.lane ?? ''),
    ];
    return createHash('sha1').update(parts.join('|')).digest('hex');
}
