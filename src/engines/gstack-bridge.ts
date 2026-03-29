/**
 * GStack Bridge — Deep Skill Embedding
 *
 * Auto-detects gstack installation and registers its skills as native
 * Nexus Prime capabilities. All gstack branding is internalized —
 * skills appear as first-class Nexus tools.
 *
 * Execution: skills run via `claude -p` with the appropriate prefix.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─��───────────────────────────────────────────────────────────────────────────

export interface NativeSkillCard {
  /** Nexus-native name (no gstack branding) */
  name: string;
  /** Original gstack skill name */
  originalName: string;
  /** Description (rewritten for Nexus context) */
  description: string;
  /** MCP tool name */
  toolName: string;
  /** Skill directory path */
  skillPath: string;
  /** Whether the skill has a SKILL.md */
  hasSkillDoc: boolean;
}

export interface SkillExecutionResult {
  success: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────���───────────────────────────

const GSTACK_PATHS = [
  path.join(os.homedir(), '.claude', 'skills', 'gstack'),
];

/** Map gstack skill names to Nexus-native tool names */
const SKILL_NAME_MAP: Record<string, { toolName: string; description: string }> = {
  browse: {
    toolName: 'nexus_browse',
    description: 'Headless browser for QA testing, site dogfooding, and web interaction. Navigate pages, interact with elements, take screenshots, and verify state.',
  },
  ship: {
    toolName: 'nexus_ship_workflow',
    description: 'Ship workflow: runs tests, lints, creates PR, and ensures quality gates pass before merging.',
  },
  review: {
    toolName: 'nexus_code_review',
    description: 'PR code review: analyzes diff, checks for bugs, suggests improvements, and provides structured feedback.',
  },
  investigate: {
    toolName: 'nexus_investigate',
    description: 'Systematic root-cause debugging: reproduces issues, traces call chains, and identifies fixes.',
  },
  'qa-only': {
    toolName: 'nexus_qa_audit',
    description: 'QA audit: report-only quality analysis without making fixes. Identifies issues and generates test plans.',
  },
  'design-review': {
    toolName: 'nexus_design_review',
    description: 'Design audit with fix loop: reviews architecture, identifies issues, and applies corrections.',
  },
  benchmark: {
    toolName: 'nexus_benchmark',
    description: 'Performance regression detection: runs benchmarks, compares against baselines, flags regressions.',
  },
  canary: {
    toolName: 'nexus_canary_monitor',
    description: 'Post-deploy monitoring loop: verifies deployment health, checks error rates, and validates SLOs.',
  },
  cso: {
    toolName: 'nexus_security_audit',
    description: 'Security audit: OWASP Top 10 + STRIDE threat modeling. Identifies vulnerabilities and suggests mitigations.',
  },
  retro: {
    toolName: 'nexus_retrospective',
    description: 'Retrospective analysis: reviews project history, identifies patterns, and generates improvement insights.',
  },
  'land-and-deploy': {
    toolName: 'nexus_land_deploy',
    description: 'Merge-to-deploy pipeline: merges PR, triggers deploy, and runs canary verification.',
  },
  autoplan: {
    toolName: 'nexus_auto_review',
    description: 'Automated review pipeline: runs CEO review, design review, and engineering review in sequence.',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// GstackBridge
// ─────────────────────────────────────────────────────────────────────────────

export class GstackBridge {
  private gstackRoot: string | null = null;
  private detectedSkills: NativeSkillCard[] = [];

  constructor() {
    this.gstackRoot = this.findGstackRoot();
    if (this.gstackRoot) {
      this.detectedSkills = this.discoverSkills();
    }
  }

  // ── Detection ────────────────────────────────────────────────────────────

  /**
   * Check if gstack is installed and accessible.
   */
  detect(): boolean {
    return this.gstackRoot !== null;
  }

  private findGstackRoot(): string | null {
    for (const candidate of GSTACK_PATHS) {
      try {
        if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'SKILL.md'))) {
          return candidate;
        }
      } catch { continue; }
    }
    return null;
  }

  // ── Skill Discovery ──────���───────────────────────────────────────────────

  /**
   * List all gstack skills registered as native Nexus capabilities.
   */
  listSkills(): NativeSkillCard[] {
    return [...this.detectedSkills];
  }

  private discoverSkills(): NativeSkillCard[] {
    if (!this.gstackRoot) return [];
    const skills: NativeSkillCard[] = [];

    for (const [skillName, meta] of Object.entries(SKILL_NAME_MAP)) {
      const skillPath = path.join(this.gstackRoot, skillName);
      const hasSkillDoc = fs.existsSync(path.join(skillPath, 'SKILL.md'));
      const hasDir = fs.existsSync(skillPath);

      if (hasDir) {
        skills.push({
          name: meta.toolName.replace('nexus_', '').replace(/_/g, '-'),
          originalName: skillName,
          description: meta.description,
          toolName: meta.toolName,
          skillPath,
          hasSkillDoc,
        });
      }
    }

    return skills;
  }

  // ── Execution ────────────────────────────────────────────────────────────

  /**
   * Execute a gstack skill by its Nexus tool name.
   * Runs via `claude -p` with the skill prefix.
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ): Promise<SkillExecutionResult> {
    const skill = this.detectedSkills.find(s => s.toolName === toolName);
    if (!skill) {
      return {
        success: false,
        output: `Skill not found: ${toolName}`,
        exitCode: 1,
        durationMs: 0,
      };
    }

    const prompt = args.prompt ?? args.goal ?? args.task ?? '';
    const command = `/${skill.originalName} ${String(prompt)}`.trim();
    const timeout = options?.timeoutMs ?? 120_000;
    const start = Date.now();

    try {
      const output = execSync(
        `claude -p "${command.replace(/"/g, '\\"')}"`,
        {
          timeout,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );

      return {
        success: true,
        output: output.trim(),
        exitCode: 0,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        success: false,
        output: err?.stdout ?? err?.message ?? 'Unknown error',
        exitCode: err?.status ?? 1,
        durationMs: Date.now() - start,
      };
    }
  }

  // ── MCP Tool Definitions ─────────────────────────────────────────────────

  /**
   * Generate MCP tool definitions for all detected gstack skills.
   * These look like native Nexus tools with no gstack branding.
   */
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return this.detectedSkills.map(skill => ({
      name: skill.toolName,
      description: skill.description,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Task description or goal for this capability',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional file paths relevant to the task',
          },
        },
        required: ['prompt'],
      },
    }));
  }
}

// ───���─────────────────────────────────────────────────────────────────────────
// Singleton
// ────────────────────────────────���────────────────────────────────────────────

let _sharedBridge: GstackBridge | null = null;

export function getGstackBridge(): GstackBridge {
  if (!_sharedBridge) {
    _sharedBridge = new GstackBridge();
  }
  return _sharedBridge;
}
