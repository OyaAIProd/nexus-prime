/**
 * ASCII art and branding utilities for Nexus Prime
 */

export interface NexusBuildMeta {
  buildDate?: string;
  nodeVersion?: string;
  platform?: string;
}

const SCI_FI_LOADER_FRAMES = [
  '⠋ orbiting quantum nodes',
  '⠙ orbiting quantum nodes',
  '⠹ orbiting quantum nodes',
  '⠸ orbiting quantum nodes',
  '⠼ orbiting quantum nodes',
  '⠴ orbiting quantum nodes',
  '⠦ orbiting quantum nodes',
  '⠧ orbiting quantum nodes',
  '⠇ orbiting quantum nodes',
  '⠏ orbiting quantum nodes',
];

export const ASCII_ART = {
  nexusPrimeLogo: `
    ███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗
    ████╗  ██║██╔════╝╚██╗██╔╝██║   ██║██╔════╝
    ██╔██╗ ██║█████╗   ╚███╔╝ ██║   ██║███████╗
    ██║╚██╗██║██╔══╝   ██╔██╗ ██║   ██║╚════██║
    ██║ ╚████║███████╗██╔╝ ██╗╚██████╔╝███████║
    ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝

    ██████╗ ██████╗ ██╗███╗   ███╗███████╗
    ██╔══██╗██╔══██╗██║████╗ ████║██╔════╝
    ██████╔╝██████╔╝██║██╔████╔██║█████╗
    ██╔═══╝ ██╔══██╗██║██║╚██╔╝██║██╔══╝
    ██║     ██║  ██║██║██║ ╚═╝ ██║███████╗
    ╚═╝     ╚═╝  ╚═╝╚═╝╚═╝     ╚═╝╚══════╝`,

  nexusPrimeLogoCompact: `
    _   _ _____  __   __ _   _  ____   ____   ___  __  __ _____
   | \\ | | ____| \\ \\ / /| | | |/ ___| |  _ \\ |_ _||  \\/  | ____|
   |  \\| |  _|    \\ V / | | | |\\___ \\ | |_) | | | | |\\/| |  _|
   | |\\  | |___    | |  | |_| | ___) ||  _ <  | | | |  | | |___
   |_| \\_|_____|   |_|   \\___/ |____/ |_| \\_\\|___||_|  |_|_____|`,

  sciFiLoaderFrames: SCI_FI_LOADER_FRAMES,
  sciFiLoaderFrameRateMs: 90,

  sciFiLoader: (frame: number): string => {
    const frames = SCI_FI_LOADER_FRAMES;
    return frames[Math.abs(frame) % frames.length];
  },

  bootSuccessMessage: (version: string, buildMeta: NexusBuildMeta = {}): string => {
    const buildDate = buildMeta.buildDate || new Date().toISOString();
    const nodeVersion = buildMeta.nodeVersion || process.version;
    const platform = buildMeta.platform || `${process.platform}/${process.arch}`;
    return `
  ╔════════════════════════════════════════════════════════════╗
  ║  ⚡ Nexus Prime v${version} Ready                               ║
  ║                                                            ║
  ║  🧠 Memory fabric initialized                              ║
  ║  🔄 Orchestration engines live                             ║
  ║  📡 MCP control plane active                               ║
  ║  ⚙️  Worker swarm standing by                              ║
  ║                                                            ║
  ║  Build: ${buildDate.slice(0, 19).padEnd(47, ' ')}║
  ║  Node : ${nodeVersion.padEnd(47, ' ')}║
  ║  Host : ${platform.padEnd(47, ' ')}║
  ╚════════════════════════════════════════════════════════════╝`;
  },
};

function selectLogoForTerminal(): string {
  const columns = Number(process.stdout.columns || 0);
  if (columns > 0 && columns < 90) {
    return ASCII_ART.nexusPrimeLogoCompact;
  }
  return ASCII_ART.nexusPrimeLogo;
}

export function installationProgressBar(step: number, total: number, label: string): string {
  const safeTotal = Math.max(1, total);
  const safeStep = Math.max(0, Math.min(step, safeTotal));
  const width = 24;
  const ratio = safeStep / safeTotal;
  const filled = Math.round(width * ratio);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
  const pct = Math.round(ratio * 100);
  return `\r\x1b[36m[${bar}]\x1b[0m ${String(pct).padStart(3, ' ')}% ${label}`;
}

export function sciFiPhaseHeader(phaseName: string, phaseNumber: number): string {
  const title = `PHASE ${phaseNumber} :: ${phaseName.toUpperCase()}`;
  const pad = '═'.repeat(Math.max(0, 68 - title.length));
  return [
    `\x1b[35m╔═ ${title} ${pad}╗\x1b[0m`,
    `\x1b[35m╚${'═'.repeat(74)}╝\x1b[0m`,
  ].join('\n');
}

export function nexusPrimeSubBrand(subtitle: string): string {
  const text = subtitle.trim() || 'Nexus Prime';
  const edge = '─'.repeat(Math.max(8, text.length + 8));
  return [
    `\x1b[90m┌${edge}┐\x1b[0m`,
    `\x1b[90m│\x1b[0m  \x1b[36m${text}\x1b[0m  \x1b[90m│\x1b[0m`,
    `\x1b[90m└${edge}┘\x1b[0m`,
  ].join('\n');
}

export function printASCIILogo(version: string): void {
  console.log('\n');
  console.log(selectLogoForTerminal());
  console.log(`\n  Local-first MCP control plane v${version}`);
  console.log('  Bootstrap. Orchestrate. Verify. Learn.\n');
}

/** @deprecated Prefer category-aware MCP visuals inside src/agents/adapters/mcp.ts */
export function printSciFiMCPInvoke(toolName: string): void {
  console.log(nexusPrimeSubBrand(`MCP invoke: ${toolName}`));
}

export function printBootSuccessMessage(version: string, buildMeta: NexusBuildMeta = {}): void {
  console.log(ASCII_ART.bootSuccessMessage(version, buildMeta));
}
