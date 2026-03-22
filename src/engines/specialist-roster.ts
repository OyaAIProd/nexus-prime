import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDomains } from './runtime-assets.js';
import { IMPORTED_SPECIALIST_PROFILES, type ImportedSpecialistProfileSeed } from './generated-specialist-profiles.js';

export type SpecialistAuthority = 'advisory' | 'review' | 'mutate';
export type OptimizationProfile = 'standard' | 'max';

export interface SelectionConfidence {
    score: number;
    reasons: string[];
}

export interface SelectedSpecialist {
    specialistId: string;
    name: string;
    division: string;
    authority: SpecialistAuthority;
    confidence: SelectionConfidence;
}

export interface SelectedCrew {
    crewId: string;
    name: string;
    summary: string;
    domains: string[];
    confidence: SelectionConfidence;
}

export interface FallbackPlan {
    summary: string;
    steps: string[];
}

export interface ReviewGateResult {
    gate: 'pm' | 'architecture' | 'code-review' | 'cto' | 'devops' | 'marketer-docs';
    status: 'planned' | 'ready' | 'blocked';
    owner: string;
    rationale: string;
}

export interface ContinuationProposal {
    summary: string;
    suggestedActions: string[];
    automationCandidates: string[];
}

export interface PlanningLedgerRow {
    stage: string;
    status: 'planned' | 'completed' | 'fallback';
    owner: string;
    selectedAssets: string[];
    notes: string;
}

export interface ToolPolicyDecision {
    allowedTools: string[];
    reasons: string[];
}

export interface SpecialistProfile {
    specialistId: string;
    name: string;
    division: string;
    description: string;
    emoji?: string;
    color?: string;
    vibe?: string;
    authority: SpecialistAuthority;
    domains: string[];
    tools: string[];
    roleAffinity: string[];
    mission: string;
    rules: string[];
    workflow: string[];
    deliverables: string[];
    communicationStyle: string[];
    successMetrics: string[];
    aliases: string[];
    recommendedSkills: string[];
    recommendedWorkflows: string[];
    rawMarkdown: string;
    sections: Record<string, string>;
    sourcePath: string;
}

export interface CrewTemplate {
    crewId: string;
    name: string;
    summary: string;
    domains: string[];
    requiredSpecialists: string[];
    optionalSpecialists: string[];
    reviewGates: ReviewGateResult['gate'][];
    fallbackCrewId?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SPECIALIST_DETAIL_DIR = path.join(__dirname, 'generated-specialist-details');

interface SpecialistDetailPayload {
    rawMarkdown: string;
    sections: Record<string, string>;
}

const specialistDetailCache = new Map<string, SpecialistDetailPayload>();

const SPECIALISTS: SpecialistProfile[] = IMPORTED_SPECIALIST_PROFILES.map(withLazyDetails).sort((left, right) =>
    left.name.localeCompare(right.name)
);

const CREWS: CrewTemplate[] = buildCrewTemplates(SPECIALISTS);

export function listSpecialists(): SpecialistProfile[] {
    return SPECIALISTS;
}

export function getSpecialist(specialistId: string): SpecialistProfile | undefined {
    const needle = specialistId.toLowerCase();
    return SPECIALISTS.find((specialist) =>
        specialist.specialistId.toLowerCase() === needle ||
        specialist.name.toLowerCase() === needle
    );
}

export function listCrewTemplates(): CrewTemplate[] {
    return CREWS;
}

export function getCrewTemplate(crewId: string): CrewTemplate | undefined {
    const needle = crewId.toLowerCase();
    return CREWS.find((crew) => crew.crewId.toLowerCase() === needle || crew.name.toLowerCase() === needle);
}

export function planSpecialists(input: {
    goal: string;
    files?: string[];
    requestedCrews?: string[];
    requestedSpecialists?: string[];
    requestedSkills?: string[];
    requestedWorkflows?: string[];
    optimizationProfile?: OptimizationProfile;
}): {
    selectedCrew: SelectedCrew;
    selectedSpecialists: SelectedSpecialist[];
    selectedSkills: string[];
    selectedWorkflows: string[];
    toolPolicy: ToolPolicyDecision;
    fallbackPlan: FallbackPlan;
    reviewGates: ReviewGateResult[];
    continuation: ContinuationProposal;
    ledger: PlanningLedgerRow[];
} {
    const requestedCrews = input.requestedCrews ?? [];
    const requestedSpecialists = input.requestedSpecialists ?? [];
    const goal = input.goal;
    const matchedDomains = detectDomains(goal, [
        ...(input.files ?? []),
        ...requestedCrews,
        ...requestedSpecialists,
        ...(input.requestedSkills ?? []),
        ...(input.requestedWorkflows ?? []),
    ]);
    const selectedCrew = selectCrew(goal, matchedDomains, requestedCrews);
    const selectedSpecialists = rankSpecialists(goal, matchedDomains, selectedCrew, requestedSpecialists, input.optimizationProfile ?? 'standard');
    const selectedSkills = dedupeStrings([
        ...(input.requestedSkills ?? []),
        ...selectedSpecialists.flatMap((entry) => getSpecialist(entry.specialistId)?.recommendedSkills ?? []),
    ]);
    const selectedWorkflows = dedupeStrings([
        ...(input.requestedWorkflows ?? []),
        ...selectedSpecialists.flatMap((entry) => getSpecialist(entry.specialistId)?.recommendedWorkflows ?? []),
    ]);
    const toolPolicy = selectToolPolicy(selectedSpecialists);
    const fallbackPlan = {
        summary: 'Fallback to current runtime domain-pack execution if specialist confidence or crew coverage is weak.',
        steps: [
            'Drop to the selected crew fallback if a required specialist is missing.',
            'Reduce to advisory/review specialists only if mutate authority is uncertain.',
            'Fall back to current skill/workflow/domain resolution if confidence remains low.',
        ],
    };
    const reviewGates = buildReviewGates(selectedCrew, selectedSpecialists);
    const continuation = {
        summary: 'After completion, queue bounded next-step recommendations through continuation-capable specialists.',
        suggestedActions: [
            'Capture follow-up backlog items from PM and architecture review.',
            'Route release-facing changes to DevOps and marketer/docs review when applicable.',
        ],
        automationCandidates: ['release-followup', 'docs-sync', 'postmortem-synthesis'],
    };
    const ledger: PlanningLedgerRow[] = [
        {
            stage: 'objective',
            status: 'completed',
            owner: 'intake-planner',
            selectedAssets: [goal.slice(0, 96)],
            notes: `Domains matched: ${matchedDomains.join(', ') || 'generic'}`,
        },
        {
            stage: 'crew-selection',
            status: 'completed',
            owner: 'crew-selector',
            selectedAssets: [selectedCrew.name],
            notes: selectedCrew.confidence.reasons.join(' | ') || 'Crew inferred from domain and explicit selectors.',
        },
        {
            stage: 'specialist-selection',
            status: 'completed',
            owner: 'specialist-selector',
            selectedAssets: selectedSpecialists.map((entry) => entry.name),
            notes: `${selectedSpecialists.length} specialists selected.`,
        },
        {
            stage: 'skill-selection',
            status: 'completed',
            owner: 'skill-selector',
            selectedAssets: selectedSkills,
            notes: selectedSkills.length > 0 ? 'Selected from explicit request + specialist affinity.' : 'No specialist-specific skills selected; runtime defaults remain active.',
        },
        {
            stage: 'workflow-selection',
            status: 'completed',
            owner: 'workflow-selector',
            selectedAssets: selectedWorkflows,
            notes: selectedWorkflows.length > 0 ? 'Selected from explicit request + specialist affinity.' : 'Workflow resolution will fall back to current runtime selection.',
        },
        {
            stage: 'tool-policy',
            status: 'completed',
            owner: 'tool-policy-selector',
            selectedAssets: toolPolicy.allowedTools,
            notes: toolPolicy.reasons.join(' | '),
        },
        {
            stage: 'fallback',
            status: 'planned',
            owner: 'architect-reviewer',
            selectedAssets: fallbackPlan.steps,
            notes: fallbackPlan.summary,
        },
        {
            stage: 'review-gates',
            status: 'planned',
            owner: 'cto-reviewer',
            selectedAssets: reviewGates.map((gate) => gate.gate),
            notes: 'Review and ship stages remain additive overlays on top of the current runtime.',
        },
    ];

    return {
        selectedCrew,
        selectedSpecialists,
        selectedSkills,
        selectedWorkflows,
        toolPolicy,
        fallbackPlan,
        reviewGates,
        continuation,
        ledger,
    };
}

function withLazyDetails(seed: ImportedSpecialistProfileSeed): SpecialistProfile {
    const profile = { ...seed } as SpecialistProfile;
    Object.defineProperty(profile, 'rawMarkdown', {
        enumerable: true,
        get() {
            return loadSpecialistDetail(seed.specialistId).rawMarkdown;
        },
    });
    Object.defineProperty(profile, 'sections', {
        enumerable: true,
        get() {
            return loadSpecialistDetail(seed.specialistId).sections;
        },
    });
    return profile;
}

function loadSpecialistDetail(specialistId: string): SpecialistDetailPayload {
    const cached = specialistDetailCache.get(specialistId);
    if (cached) return cached;

    const detailPath = path.join(SPECIALIST_DETAIL_DIR, `${specialistId}.json`);
    if (!fs.existsSync(detailPath)) {
        const fallback: SpecialistDetailPayload = { rawMarkdown: '', sections: {} };
        specialistDetailCache.set(specialistId, fallback);
        return fallback;
    }

    const parsed = JSON.parse(fs.readFileSync(detailPath, 'utf8')) as SpecialistDetailPayload;
    specialistDetailCache.set(specialistId, parsed);
    return parsed;
}

function buildCrewTemplates(specialists: SpecialistProfile[]): CrewTemplate[] {
    const byName = (parts: string[]) =>
        specialists
            .filter((specialist) => parts.every((part) => specialist.name.toLowerCase().includes(part)))
            .map((specialist) => specialist.specialistId);

    const requireDivision = (division: string, limit: number) =>
        specialists
            .filter((specialist) => specialist.division === division)
            .slice(0, limit)
            .map((specialist) => specialist.specialistId);

    const gates = (...values: ReviewGateResult['gate'][]): CrewTemplate['reviewGates'] => values;

    return [
        {
            crewId: 'crew_pdlc',
            name: 'PDLC Crew',
            summary: 'Sequential planning, implementation, QA, and shipping for product delivery.',
            domains: ['pdlc', 'product', 'backend', 'frontend'],
            requiredSpecialists: dedupeStrings([
                ...byName(['project']),
                ...byName(['frontend']),
                ...byName(['backend']),
                ...byName(['evidence']),
            ]).slice(0, 5),
            optionalSpecialists: requireDivision('product', 3),
            reviewGates: gates('pm', 'architecture', 'code-review', 'cto', 'devops', 'marketer-docs'),
            fallbackCrewId: 'crew_implementation',
        },
        {
            crewId: 'crew_implementation',
            name: 'Implementation Crew',
            summary: 'Execution-focused engineering crew with verifier and release safety.',
            domains: ['backend', 'frontend', 'typescript', 'node', 'python', 'django', 'react'],
            requiredSpecialists: dedupeStrings([
                ...byName(['frontend']),
                ...byName(['backend']),
                ...byName(['senior', 'developer']),
                ...byName(['reality']),
            ]).slice(0, 5),
            optionalSpecialists: dedupeStrings([
                ...byName(['devops']),
                ...byName(['security']),
                ...byName(['performance']),
            ]).slice(0, 4),
            reviewGates: gates('architecture', 'code-review', 'cto', 'devops'),
            fallbackCrewId: 'crew_research',
        },
        {
            crewId: 'crew_gtm',
            name: 'GTM Crew',
            summary: 'Launch, growth, messaging, and content specialists working from shipped capability.',
            domains: ['gtm', 'marketing', 'sales', 'writing'],
            requiredSpecialists: dedupeStrings([
                ...byName(['growth']),
                ...byName(['content']),
                ...byName(['social']),
                ...byName(['executive', 'summary']),
            ]).slice(0, 5),
            optionalSpecialists: dedupeStrings([
                ...requireDivision('marketing', 5),
                ...requireDivision('paid-media', 3),
                ...requireDivision('strategy', 3),
            ]).slice(0, 5),
            reviewGates: gates('pm', 'architecture', 'cto', 'marketer-docs'),
            fallbackCrewId: 'crew_content',
        },
        {
            crewId: 'crew_content',
            name: 'Content Crew',
            summary: 'Writing, storytelling, and distribution specialists for content and docs surfaces.',
            domains: ['writing', 'marketing'],
            requiredSpecialists: dedupeStrings([
                ...byName(['content']),
                ...byName(['storyteller']),
                ...byName(['executive', 'summary']),
            ]).slice(0, 4),
            optionalSpecialists: requireDivision('marketing', 4),
            reviewGates: gates('pm', 'cto', 'marketer-docs'),
        },
        {
            crewId: 'crew_finance',
            name: 'Finance Crew',
            summary: 'Finance, analytics, and strategic review specialists for business and economics tasks.',
            domains: ['finance', 'economics', 'data'],
            requiredSpecialists: dedupeStrings([
                ...byName(['finance']),
                ...byName(['analytics']),
                ...requireDivision('strategy', 2),
            ]).slice(0, 4),
            optionalSpecialists: requireDivision('support', 3),
            reviewGates: gates('pm', 'cto'),
        },
        {
            crewId: 'crew_security',
            name: 'Security Crew',
            summary: 'Threat, trust, identity, and secure release specialists.',
            domains: ['security', 'trust', 'identity'],
            requiredSpecialists: dedupeStrings([
                ...byName(['security']),
                ...byName(['identity']),
                ...byName(['trust']),
            ]).slice(0, 4),
            optionalSpecialists: dedupeStrings([
                ...byName(['backend']),
                ...byName(['devops']),
            ]).slice(0, 3),
            reviewGates: gates('architecture', 'code-review', 'cto', 'devops'),
            fallbackCrewId: 'crew_implementation',
        },
        {
            crewId: 'crew_research',
            name: 'Research Crew',
            summary: 'Research, architecture, analysis, and evidence collection for uncertain tasks.',
            domains: ['deep-tech', 'research', 'ai'],
            requiredSpecialists: dedupeStrings([
                ...byName(['trend']),
                ...byName(['ux', 'researcher']),
                ...byName(['tool', 'evaluator']),
                ...byName(['data', 'analytics']),
            ]).slice(0, 4),
            optionalSpecialists: dedupeStrings([
                ...requireDivision('specialized', 4),
                ...requireDivision('testing', 3),
            ]).slice(0, 5),
            reviewGates: gates('pm', 'architecture', 'cto'),
        },
    ].map((crew) => ({
        ...crew,
        requiredSpecialists: dedupeStrings(crew.requiredSpecialists),
        optionalSpecialists: dedupeStrings(crew.optionalSpecialists.filter((id) => !crew.requiredSpecialists.includes(id))),
    }));
}

function selectCrew(goal: string, matchedDomains: string[], requestedCrews: string[]): SelectedCrew {
    const requestSet = new Set(requestedCrews.map((value) => value.toLowerCase()));
    const ranked = CREWS
        .map((crew) => {
            let score = 0.1;
            const reasons: string[] = [];
            if (requestSet.has(crew.crewId.toLowerCase()) || requestSet.has(crew.name.toLowerCase())) {
                score += 0.7;
                reasons.push('Explicit crew selector matched.');
            }
            const domainHits = crew.domains.filter((domain) => matchedDomains.includes(domain));
            if (domainHits.length > 0) {
                score += Math.min(0.4, domainHits.length * 0.12);
                reasons.push(`Matched domains: ${domainHits.join(', ')}`);
            }
            if (goal.toLowerCase().includes('release')) {
                if (crew.reviewGates.includes('devops')) {
                    score += 0.15;
                    reasons.push('Includes DevOps shipping gate.');
                }
            }
            return { crew, confidence: { score: Math.min(score, 0.99), reasons } };
        })
        .sort((left, right) => right.confidence.score - left.confidence.score);

    const chosen = ranked[0] ?? {
        crew: CREWS[0],
        confidence: { score: 0.4, reasons: ['Defaulted to the first available crew.'] },
    };

    return {
        crewId: chosen.crew.crewId,
        name: chosen.crew.name,
        summary: chosen.crew.summary,
        domains: chosen.crew.domains,
        confidence: chosen.confidence,
    };
}

function rankSpecialists(
    goal: string,
    matchedDomains: string[],
    crew: SelectedCrew,
    requestedSpecialists: string[],
    optimizationProfile: OptimizationProfile
): SelectedSpecialist[] {
    const requestSet = new Set(requestedSpecialists.map((value) => value.toLowerCase()));
    const crewTemplate = getCrewTemplate(crew.crewId);
    const seededIds = new Set([...(crewTemplate?.requiredSpecialists ?? []), ...(crewTemplate?.optionalSpecialists ?? [])]);

    const ranked = SPECIALISTS.map((specialist) => {
        let score = 0.05;
        const reasons: string[] = [];

        if (seededIds.has(specialist.specialistId)) {
            score += 0.35;
            reasons.push(`Included in ${crew.name}.`);
        }
        if (requestSet.has(specialist.specialistId.toLowerCase()) || requestSet.has(specialist.name.toLowerCase())) {
            score += 0.45;
            reasons.push('Explicit specialist selector matched.');
        }
        const domainHits = specialist.domains.filter((domain) => matchedDomains.includes(domain));
        if (domainHits.length > 0) {
            score += Math.min(0.3, domainHits.length * 0.08);
            reasons.push(`Matched domains: ${domainHits.join(', ')}`);
        }
        if (goal.toLowerCase().includes('review') && specialist.authority !== 'mutate') {
            score += 0.08;
            reasons.push('Review-oriented task prefers advisory/review specialists.');
        }
        if (goal.toLowerCase().includes('implement') && specialist.authority === 'mutate') {
            score += 0.08;
            reasons.push('Implementation task prefers mutate-capable specialists.');
        }

        return {
            specialist,
            confidence: {
                score: Math.min(score, 0.99),
                reasons,
            },
        };
    }).sort((left, right) => right.confidence.score - left.confidence.score);

    const take = optimizationProfile === 'max' ? 6 : 4;
    return ranked
        .filter((entry) => entry.confidence.score >= 0.2 || seededIds.has(entry.specialist.specialistId))
        .slice(0, take)
        .map((entry) => ({
            specialistId: entry.specialist.specialistId,
            name: entry.specialist.name,
            division: entry.specialist.division,
            authority: entry.specialist.authority,
            confidence: entry.confidence,
        }));
}

function selectToolPolicy(selectedSpecialists: SelectedSpecialist[]): ToolPolicyDecision {
    const specialists = selectedSpecialists
        .map((entry) => getSpecialist(entry.specialistId))
        .filter(Boolean) as SpecialistProfile[];
    const allowedTools = dedupeStrings(specialists.flatMap((specialist) => specialist.tools));
    return {
        allowedTools: allowedTools.length > 0 ? allowedTools : ['read_file', 'run_command'],
        reasons: [
            'Selected from specialist tool preferences and authority constraints.',
            specialists.some((specialist) => specialist.authority === 'mutate')
                ? 'Mutate-capable specialists enabled write-capable tools.'
                : 'Advisory/review specialists kept the tool policy conservative.',
        ],
    };
}

function buildReviewGates(crew: SelectedCrew, selectedSpecialists: SelectedSpecialist[]): ReviewGateResult[] {
    const owner = selectedSpecialists[0]?.name ?? crew.name;
    return [
        { gate: 'pm', status: 'planned', owner, rationale: 'Scope, audience, and success criteria review.' },
        { gate: 'architecture', status: 'planned', owner, rationale: 'Interface and fallback review before execution.' },
        { gate: 'code-review', status: 'planned', owner: 'Code Review Layer', rationale: 'Post-verifier implementation review.' },
        { gate: 'cto', status: 'planned', owner: 'CTO Review Layer', rationale: 'Release-readiness and system-quality review.' },
        { gate: 'devops', status: 'planned', owner: 'DevOps Shipper', rationale: 'Packaging, release notes, deploy, and rollback.' },
        { gate: 'marketer-docs', status: 'planned', owner: 'Marketer Docs Layer', rationale: 'Append-only website/docs/README surfacing.' },
    ];
}

function dedupeStrings(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}
