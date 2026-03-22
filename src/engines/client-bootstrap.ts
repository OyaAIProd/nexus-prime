import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { InstructionGateway, type ClientBootstrapArtifact } from './instruction-gateway.js';
import { resolveNexusStateDir } from './runtime-registry.js';
import { MemoryEngine } from './memory.js';

export type SetupClientId = 'cursor' | 'claude' | 'claude-code' | 'claude-desktop' | 'opencode' | 'windsurf' | 'antigravity' | 'openclaw' | 'codex' | 'aider' | 'continue' | 'cline';
export type SetupInstructionMode = 'replace' | 'codex-managed-agents';
export type SetupInstructionScope = 'home' | 'workspace';
export type SetupState = 'missing' | 'drifted' | 'installed';

export interface SetupInstructionFile {
    path: string;
    content: string;
    scope: SetupInstructionScope;
    mode?: SetupInstructionMode;
}

export interface SetupDefinition {
    id: SetupClientId;
    label: string;
    configPath?: string;
    instructionFiles: SetupInstructionFile[];
}

export interface BootstrapManifestClientStatus {
    clientId: SetupClientId;
    label: string;
    state: SetupState;
    configPath?: string;
    instructionFiles: string[];
    homeReady: boolean;
    workspaceReady: boolean;
    summary: string;
    updatedAt: number;
}

export interface BootstrapManifestStatus {
    version: number;
    generatedAt: number;
    workspaceRoot?: string;
    clients: BootstrapManifestClientStatus[];
}

export interface EnsureBootstrapOptions {
    packageRoot: string;
    workspaceRoot?: string;
    phase?: 'install' | 'runtime';
    silent?: boolean;
    dryRun?: boolean;
}

const CODEX_MANAGED_START = '<!-- nexus-prime:codex-bootstrap:start -->';
const CODEX_MANAGED_END = '<!-- nexus-prime:codex-bootstrap:end -->';
const SUPPORTED_CLIENTS: SetupClientId[] = ['codex', 'cursor', 'claude', 'claude-code', 'claude-desktop', 'opencode', 'windsurf', 'antigravity', 'openclaw', 'aider', 'continue', 'cline'];
const WORKSPACE_SEED_FILES: Array<{ relativePath: string; content: string }> = [
    {
        relativePath: '.agent/hooks/before-mutate-guard.md',
        content: `---
name: before-mutate-guard
description: Local checkpoint before bounded file mutation.
trigger: before-mutate
riskClass: read
domain: orchestration
---

Project-local hook seed. Customize this file to document extra mutation rules for this repository.
`,
    },
    {
        relativePath: '.agent/hooks/failure-summary.md',
        content: `---
name: failure-summary
description: Local failure checkpoint for recovery notes and retry scope.
trigger: run.failed
riskClass: read
domain: workflows
---

Project-local hook seed. Customize this file to capture repo-specific failure recovery notes.
`,
    },
    {
        relativePath: '.agent/hooks/memory-stored-review.md',
        content: `---
name: memory-stored-review
description: Local review hook for important stored memories.
trigger: memory.stored
riskClass: read
domain: memory
---

Project-local hook seed. Customize this file when memory writes need repo-specific review rules.
`,
    },
    {
        relativePath: '.agent/automations/session-close-followup.md',
        content: `---
name: session-close-followup
description: Queue a bounded approval follow-up after a verified run.
triggerMode: event
eventTrigger: run.verified
domain: workflows
workflows:
  - workflows-approval-loop
---

Project-local automation seed. Customize this file to add repo-specific post-verify follow-up steps.
`,
    },
    {
        relativePath: '.agent/automations/failure-followup.md',
        content: `---
name: failure-followup
description: Queue a bounded retry follow-up after a failed run.
triggerMode: event
eventTrigger: run.failed
domain: orchestration
hooks:
  - retry-narrow-scope
---

Project-local automation seed. Customize this file to add repo-specific failure recovery behavior.
`,
    },
];

function ensureParentDir(targetPath: string): void {
    mkdirSync(dirname(targetPath), { recursive: true });
}

export function validateTargetPath(targetPath: string): { valid: boolean; reason?: string } {
    const parent = dirname(targetPath);
    try {
        if (!existsSync(parent)) {
            // Parent will be created by ensureParentDir — check grandparent is writable
            const grandparent = dirname(parent);
            if (existsSync(grandparent)) {
                accessSync(grandparent, constants.W_OK);
            }
            return { valid: true };
        }
        // Check parent is actually a directory and writable
        const stat = lstatSync(parent);
        if (!stat.isDirectory()) {
            return { valid: false, reason: `Parent path is not a directory: ${parent}` };
        }
        accessSync(parent, constants.W_OK);
        return { valid: true };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { valid: false, reason: `Cannot write to ${parent}: ${message}` };
    }
}

function resolveClaudeCodeConfigDir(): string {
    // XDG-aware resolution: check XDG_CONFIG_HOME, then ~/.config/claude/, then ~/.claude/
    const xdgConfig = process.env.XDG_CONFIG_HOME;
    if (xdgConfig) {
        const xdgClaudePath = join(xdgConfig, 'claude');
        if (existsSync(xdgClaudePath)) return xdgClaudePath;
    }
    const configClaudePath = join(homedir(), '.config', 'claude');
    if (existsSync(configClaudePath)) return configClaudePath;
    return join(homedir(), '.claude');
}

function readJson(targetPath: string): any {
    if (!existsSync(targetPath)) return {};
    try {
        return JSON.parse(readFileSync(targetPath, 'utf8'));
    } catch {
        return {};
    }
}

function buildStandardMcpServerConfig() {
    return {
        command: 'npx',
        args: ['-y', 'nexus-prime', 'mcp'],
        env: {
            NEXUS_MCP_TOOL_PROFILE: 'autonomous',
        },
    };
}

function isAtlasDetected(): boolean {
    try {
        const configPath = join(homedir(), '.goatlas', 'config.json');
        if (existsSync(configPath)) return true;
    } catch { /* ignore */ }
    try {
        execSync('which goatlas', { stdio: 'ignore', timeout: 2000 });
        return true;
    } catch { /* ignore */ }
    return false;
}

function writeStandardMcpConfig(targetPath: string): void {
    const existing = readJson(targetPath);
    existing.mcpServers = existing.mcpServers ?? {};
    existing.mcpServers['nexus-prime'] = buildStandardMcpServerConfig();
    // Auto-configure atlas code intelligence peer when detected
    if (isAtlasDetected() && !existing.mcpServers['atlas']) {
        existing.mcpServers['atlas'] = { command: 'goatlas', args: ['mcp'] };
    }
    ensureParentDir(targetPath);
    writeFileSync(targetPath, JSON.stringify(existing, null, 2));
}

function writeOpencodeConfig(targetPath: string): void {
    const existing = readJson(targetPath);
    const server = {
        type: 'local',
        command: 'npx',
        args: ['-y', 'nexus-prime', 'mcp'],
        environment: {
            NEXUS_MCP_TOOL_PROFILE: 'autonomous',
        },
    };
    existing.mcp = existing.mcp ?? {};
    existing.mcp['nexus-prime'] = server;
    delete existing.mcp.servers;
    ensureParentDir(targetPath);
    writeFileSync(targetPath, JSON.stringify(existing, null, 2));
}

function renderCodexManagedBlock(content: string): string {
    return [
        CODEX_MANAGED_START,
        '## Nexus Prime Bootstrap (managed)',
        '',
        '> This block is managed by `nexus-prime setup codex` or automatic bootstrap.',
        '> Keep your project-specific Codex guidance above or below it.',
        '',
        content.trim(),
        CODEX_MANAGED_END,
    ].join('\n');
}

function mergeCodexAgentsContent(existingContent: string | null, content: string): string {
    const managedBlock = renderCodexManagedBlock(content);
    const existing = existingContent ?? '';

    if (!existing.trim()) {
        return [
            '# AGENTS.md',
            '',
            'This file is used by Codex and other repo-local agent tooling.',
            '',
            managedBlock,
            '',
        ].join('\n');
    }

    const startIndex = existing.indexOf(CODEX_MANAGED_START);
    const endIndex = existing.indexOf(CODEX_MANAGED_END);
    if (startIndex >= 0 && endIndex > startIndex) {
        const before = existing.slice(0, startIndex).trimEnd();
        const after = existing.slice(endIndex + CODEX_MANAGED_END.length).trimStart();
        return [
            before,
            before ? '' : undefined,
            managedBlock,
            after ? '' : undefined,
            after,
            '',
        ].filter((value): value is string => value !== undefined).join('\n');
    }

    return [
        existing.trimEnd(),
        '',
        managedBlock,
        '',
    ].join('\n');
}

function hasCurrentCodexManagedBlock(targetPath: string, content: string): SetupState {
    if (!existsSync(targetPath)) return 'missing';
    const existing = readFileSync(targetPath, 'utf8');
    const startIndex = existing.indexOf(CODEX_MANAGED_START);
    const endIndex = existing.indexOf(CODEX_MANAGED_END);
    if (startIndex < 0 || endIndex <= startIndex) return 'drifted';
    const currentBlock = existing.slice(startIndex, endIndex + CODEX_MANAGED_END.length).trim();
    return currentBlock === renderCodexManagedBlock(content).trim() ? 'installed' : 'drifted';
}

function buildInstructionFiles(
    clientId: SetupClientId,
    packageRoot: string,
    workspaceRoot: string,
): SetupInstructionFile[] {
    const gateway = new InstructionGateway(packageRoot);
    const resolvedClientId = clientId === 'claude' || clientId === 'claude-desktop' ? 'claude-code' : clientId;
    const bundle = gateway.renderClientBootstrapBundle(resolvedClientId, {
        toolProfile: 'autonomous',
    });

    if (clientId === 'codex') {
        return bundle.artifacts.map((artifact: ClientBootstrapArtifact) => ({
            path: join(workspaceRoot, 'AGENTS.md'),
            content: artifact.content,
            mode: 'codex-managed-agents',
            scope: 'workspace',
        }));
    }
    if (clientId === 'cursor') {
        return bundle.artifacts.map((artifact: ClientBootstrapArtifact) => ({
            path: join(workspaceRoot, '.cursor', 'rules', artifact.fileName),
            content: artifact.content,
            scope: 'workspace',
        }));
    }
    if (clientId === 'windsurf') {
        return bundle.artifacts.map((artifact: ClientBootstrapArtifact) => ({
            path: join(workspaceRoot, artifact.fileName),
            content: artifact.content,
            scope: 'workspace',
        }));
    }
    if (clientId === 'antigravity' || clientId === 'openclaw') {
        return bundle.artifacts.map((artifact: ClientBootstrapArtifact) => ({
            path: join(homedir(), '.antigravity', 'skills', 'nexus-prime', artifact.fileName),
            content: artifact.content,
            scope: 'home',
        }));
    }
    if (clientId === 'aider') {
        return bundle.artifacts.map((artifact: ClientBootstrapArtifact) => ({
            path: join(workspaceRoot, '.aider', artifact.fileName),
            content: artifact.content,
            scope: 'workspace',
        }));
    }
    if (clientId === 'continue') {
        return bundle.artifacts.map((artifact: ClientBootstrapArtifact) => ({
            path: join(workspaceRoot, '.continue', artifact.fileName),
            content: artifact.content,
            scope: 'workspace',
        }));
    }
    if (clientId === 'cline') {
        return bundle.artifacts.map((artifact: ClientBootstrapArtifact) => ({
            path: join(workspaceRoot, '.cline', artifact.fileName),
            content: artifact.content,
            scope: 'workspace',
        }));
    }
    const fileName = clientId === 'claude' || clientId === 'claude-code' || clientId === 'claude-desktop' ? 'claude-code.md' : 'opencode.md';
    return bundle.artifacts.map((artifact: ClientBootstrapArtifact, index) => ({
        path: join(
            workspaceRoot,
            '.agent',
            'client-bootstrap',
            index === 0 ? fileName : `${fileName.replace(/\.md$/, '')}-${index + 1}.md`,
        ),
        content: artifact.content,
        scope: 'workspace',
    }));
}

export function getSetupDefinition(
    clientId: SetupClientId,
    options: { packageRoot: string; workspaceRoot?: string },
): SetupDefinition {
    const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    const instructionFiles = buildInstructionFiles(clientId, resolve(options.packageRoot), workspaceRoot);
    if (clientId === 'codex') {
        return { id: clientId, label: 'Codex', instructionFiles };
    }
    if (clientId === 'cursor') {
        const workspacePath = resolve(options.workspaceRoot ?? process.cwd());
        return {
            id: clientId,
            label: 'Cursor',
            configPath: join(workspacePath, '.cursor', 'mcp.json'),
            instructionFiles,
        };
    }
    if (clientId === 'claude' || clientId === 'claude-code') {
        return {
            id: clientId,
            label: 'Claude Code',
            configPath: join(workspaceRoot, '.mcp.json'),
            instructionFiles,
        };
    }
    if (clientId === 'claude-desktop') {
        const claudeDesktopPath = process.platform === 'darwin'
            ? join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
            : process.platform === 'win32'
                ? join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json')
                : join(resolveClaudeCodeConfigDir(), 'claude_desktop_config.json');
        return {
            id: clientId,
            label: 'Claude Desktop',
            configPath: claudeDesktopPath,
            instructionFiles,
        };
    }
    if (clientId === 'opencode') {
        return {
            id: clientId,
            label: 'Opencode',
            configPath: join(homedir(), '.config', 'opencode', 'opencode.json'),
            instructionFiles,
        };
    }
    if (clientId === 'windsurf') {
        return {
            id: clientId,
            label: 'Windsurf',
            configPath: join(homedir(), '.windsurf', 'mcp.json'),
            instructionFiles,
        };
    }
    if (clientId === 'aider') {
        return {
            id: clientId,
            label: 'Aider',
            configPath: join(homedir(), '.aider', 'mcp.json'),
            instructionFiles,
        };
    }
    if (clientId === 'continue') {
        return {
            id: clientId,
            label: 'Continue.dev',
            configPath: join(homedir(), '.continue', 'config.json'),
            instructionFiles,
        };
    }
    if (clientId === 'cline') {
        return {
            id: clientId,
            label: 'Cline',
            configPath: join(homedir(), '.vscode', 'cline-mcp.json'),
            instructionFiles,
        };
    }
    if (clientId === 'openclaw') {
        return {
            id: clientId,
            label: 'OpenClaw',
            configPath: join(homedir(), '.openclaw', 'openclaw.json'),
            instructionFiles,
        };
    }
    return {
        id: clientId,
        label: 'Antigravity',
        configPath: join(homedir(), '.antigravity', 'mcp.json'),
        instructionFiles,
    };
}

export function installSetup(
    definition: SetupDefinition,
    options: { scope?: 'all' | 'home' | 'workspace' } = {},
): void {
    const scope = options.scope ?? 'all';
    if (definition.configPath && scope !== 'workspace') {
        const configCheck = validateTargetPath(definition.configPath);
        if (!configCheck.valid) {
            console.warn(`[nexus-prime] Skipping config for ${definition.label}: ${configCheck.reason}`);
        } else if (definition.id === 'opencode') {
            writeOpencodeConfig(definition.configPath);
        } else {
            writeStandardMcpConfig(definition.configPath);
        }
    }
    for (const file of definition.instructionFiles) {
        if (scope === 'home' && file.scope !== 'home') continue;
        if (scope === 'workspace' && file.scope !== 'workspace') continue;
        const pathCheck = validateTargetPath(file.path);
        if (!pathCheck.valid) {
            console.warn(`[nexus-prime] Skipping instruction file ${file.path}: ${pathCheck.reason}`);
            continue;
        }
        ensureParentDir(file.path);
        if (file.mode === 'codex-managed-agents') {
            const existing = existsSync(file.path) ? readFileSync(file.path, 'utf8') : null;
            writeFileSync(file.path, mergeCodexAgentsContent(existing, file.content), 'utf8');
            continue;
        }
        writeFileSync(file.path, file.content, 'utf8');
    }
}

export function hasExpectedConfig(definition: SetupDefinition): boolean {
    if (!definition.configPath || !existsSync(definition.configPath)) return false;
    try {
        const parsed = JSON.parse(readFileSync(definition.configPath, 'utf8'));
        if (definition.id === 'opencode') {
            const server = parsed?.mcp?.['nexus-prime'];
            return Boolean(
                server
                && server.type === 'local'
                && server.command === 'npx'
                && Array.isArray(server.args)
                && server.args.includes('nexus-prime')
                && server?.environment?.NEXUS_MCP_TOOL_PROFILE === 'autonomous'
            );
        }
        const server = parsed?.mcpServers?.['nexus-prime'];
        return Boolean(
            server
            && server.command === 'npx'
            && Array.isArray(server.args)
            && server.args.includes('nexus-prime')
            && server?.env?.NEXUS_MCP_TOOL_PROFILE === 'autonomous',
        );
    } catch {
        return false;
    }
}

function instructionState(definition: SetupDefinition, scope?: SetupInstructionScope): SetupState {
    let hasAny = false;
    for (const file of definition.instructionFiles) {
        if (scope && file.scope !== scope) continue;
        if (file.mode === 'codex-managed-agents') {
            const codexState = hasCurrentCodexManagedBlock(file.path, file.content);
            if (codexState === 'drifted') return 'drifted';
            if (codexState === 'installed') hasAny = true;
            continue;
        }
        if (!existsSync(file.path)) continue;
        hasAny = true;
        if (readFileSync(file.path, 'utf8') !== file.content) {
            return 'drifted';
        }
    }
    if (!hasAny) return 'missing';
    return definition.instructionFiles
        .filter((file) => !scope || file.scope === scope)
        .every((file) => existsSync(file.path))
        ? 'installed'
        : 'missing';
}

export function statusForDefinition(definition: SetupDefinition): { state: SetupState; summary: string; homeReady: boolean; workspaceReady: boolean } {
    const configOk = definition.configPath ? hasExpectedConfig(definition) : true;
    const workspaceState = instructionState(definition, 'workspace');
    const homeState = instructionState(definition, 'home');
    const homeReady = configOk && homeState !== 'drifted';
    const workspaceReady = workspaceState === 'installed' || definition.instructionFiles.every((file) => file.scope !== 'workspace');
    if (configOk && workspaceState !== 'drifted' && homeState !== 'drifted' && workspaceReady) {
        return {
            state: 'installed',
            summary: definition.configPath
                ? 'Config and client instructions are current'
                : 'Managed client instructions are current',
            homeReady,
            workspaceReady,
        };
    }
    if ((definition.configPath && existsSync(definition.configPath)) || workspaceState !== 'missing' || homeState !== 'missing') {
        return {
            state: 'drifted',
            summary: definition.configPath
                ? 'Setup exists but is missing the autonomous profile or current instructions'
                : 'A client instruction file exists, but the managed Nexus Prime bootstrap block is missing or outdated',
            homeReady,
            workspaceReady,
        };
    }
    return {
        state: 'missing',
        summary: definition.configPath ? 'Setup not installed yet' : 'No managed client instruction file installed yet',
        homeReady: false,
        workspaceReady: false,
    };
}

export function supportedSetupClients(): SetupClientId[] {
    return [...SUPPORTED_CLIENTS];
}

function workspaceEligible(workspaceRoot: string): boolean {
    return existsSync(join(workspaceRoot, 'package.json'))
        || existsSync(join(workspaceRoot, '.git'))
        || existsSync(join(workspaceRoot, 'AGENTS.md'));
}

function ensureWorkspaceAgentScaffold(workspaceRoot: string): void {
    const directories = [
        '.agent',
        '.agent/client-bootstrap',
        '.agent/runtime',
        '.agent/rules',
        '.agent/skills',
        '.agent/workflows',
        '.agent/hooks',
        '.agent/automations',
        '.agent/crews',
        '.agent/specialists',
    ];
    directories.forEach((relativeDir) => {
        mkdirSync(join(workspaceRoot, relativeDir), { recursive: true });
    });
    for (const seed of WORKSPACE_SEED_FILES) {
        const target = join(workspaceRoot, seed.relativePath);
        if (!existsSync(target)) {
            writeFileSync(target, seed.content, 'utf8');
        }
    }
}

function bootstrapManifestPath(stateRoot?: string): string {
    return join(stateRoot ?? resolveNexusStateDir(), 'bootstrap-manifest.json');
}

export function readBootstrapManifest(stateRoot?: string): BootstrapManifestStatus | undefined {
    const target = bootstrapManifestPath(stateRoot);
    if (!existsSync(target)) return undefined;
    try {
        return JSON.parse(readFileSync(target, 'utf8')) as BootstrapManifestStatus;
    } catch {
        return undefined;
    }
}

export function writeBootstrapManifest(status: BootstrapManifestStatus, stateRoot?: string): BootstrapManifestStatus {
    const target = bootstrapManifestPath(stateRoot);
    ensureParentDir(target);
    writeFileSync(target, JSON.stringify(status, null, 2), 'utf8');
    return status;
}

export function collectBootstrapManifest(options: { packageRoot: string; workspaceRoot?: string }): BootstrapManifestStatus {
    const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    return {
        version: 1,
        generatedAt: Date.now(),
        workspaceRoot,
        clients: SUPPORTED_CLIENTS.map((clientId) => {
            const definition = getSetupDefinition(clientId, { packageRoot: options.packageRoot, workspaceRoot });
            const status = statusForDefinition(definition);
            return {
                clientId,
                label: definition.label,
                state: status.state,
                configPath: definition.configPath,
                instructionFiles: definition.instructionFiles.map((file) => file.path),
                homeReady: status.homeReady,
                workspaceReady: status.workspaceReady,
                summary: status.summary,
                updatedAt: Date.now(),
            } satisfies BootstrapManifestClientStatus;
        }),
    };
}

export function ensureBootstrap(options: EnsureBootstrapOptions): BootstrapManifestStatus {
    const packageRoot = resolve(options.packageRoot);
    if (!existsSync(packageRoot)) {
        throw new Error(`Invalid packageRoot: path does not exist (${packageRoot})`);
    }

    const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    const allowWorkspace = workspaceEligible(workspaceRoot);
    const scope: 'all' | 'home' = allowWorkspace ? 'all' : 'home';

    if (options.dryRun) {
        return collectBootstrapManifest({ packageRoot, workspaceRoot });
    }

    if (allowWorkspace) {
        ensureWorkspaceAgentScaffold(workspaceRoot);
        
        // Phase 3F: Instant Aha Moment welcome memory
        try {
            const memory = new MemoryEngine();
            memory.store(
                "Welcome to Nexus Prime! Nexus Prime is fully installed and tracking context for your workspace. Use '/nexus' to ask me to analyze the codebase, run agents, and automate tasks.",
                1.0,
                ['welcome', 'onboard', 'system-bootstrap']
            );
        } catch (err) {
            console.warn('Failed to initialize welcome memory:', err);
        }
    }

    for (const clientId of SUPPORTED_CLIENTS) {
        try {
            const definition = getSetupDefinition(clientId, { packageRoot, workspaceRoot });
            
            const configPath = definition.configPath;
            if (configPath) {
                try {
                    const stat = statSync(configPath);
                    const mtimeMs = stat.mtimeMs;
                    const now = Date.now();
                    if (now - mtimeMs < 60000) {
                        continue;
                    }
                } catch {
                    // File doesn't exist or other error - proceed with write
                }
            }
            
            installSetup(definition, { scope });
        } catch (error) {
            console.warn(`Bootstrap failed for client ${clientId}: ${error}`);
        }
    }

    const manifest = collectBootstrapManifest({ packageRoot, workspaceRoot });
    writeBootstrapManifest(manifest);
    return manifest;
}
