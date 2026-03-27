/**
 * ASCII art and branding utilities for Nexus Prime
 */

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

  sciFiLoader: (frame: number): string => {
    const frames = [
      '  ◢▌  ◢◣ ◢▌  ◢◣ ◢▌',
      '  ▌◣  ◣◢ ▌◣  ◣◢ ▌◣',
      '  ◣▌  ◢◣ ◣▌  ◢◣ ◣▌',
      '  ▌◢  ◣◢ ▌◢  ◣◢ ▌◢',
    ];
    return frames[frame % frames.length];
  },

  sciFiMCP: (toolName: string): string => {
    return `
  ⟨═══ MCP INVOCATION ═══⟩
  → Tool: ${toolName}
  ◈ Routing through neural lattice...
  ◆ Engaging quantum pathways...
  ◈ Synchronizing worker collective...`;
  },

  bootSuccessMessage: (version: string): string => {
    return `
  ╔════════════════════════════════════════╗
  ║  ⚡ Nexus Prime v${version} Ready ⚡      ║
  ║                                        ║
  ║  🧠 Memory fabric initialized          ║
  ║  🔄 Orchestration engines live         ║
  ║  📡 MCP control plane active           ║
  ║  ⚙️  Worker swarm standing by          ║
  ╚════════════════════════════════════════╝`;
  },
};

export function printASCIILogo(version: string): void {
  console.log('\n');
  console.log(ASCII_ART.nexusPrimeLogo);
  console.log(`\n  Local-first MCP control plane v${version}`);
  console.log('  Bootstrap. Orchestrate. Verify. Learn.\n');
}

export function printSciFiMCPInvoke(toolName: string): void {
  console.log(ASCII_ART.sciFiMCP(toolName));
}

export function printBootSuccessMessage(version: string): void {
  console.log(ASCII_ART.bootSuccessMessage(version));
}
