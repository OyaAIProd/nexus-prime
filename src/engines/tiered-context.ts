import * as fs from 'fs';
import * as path from 'path';

export type ContextTier = 'L0' | 'L1' | 'L2';

export interface TieredContextResult {
    tier: ContextTier;
    content: string;
    tokens: number;
}

export class TieredContextEngine {
    constructor() {}

    /**
     * Loads file content based on the requested tier.
     * L0: Skip (returns empty string or just the file name)
     * L1: Outline (file signature, functions, classes, imports)
     * L2: Full content
     */
    public loadTier(filePath: string, tier: ContextTier): TieredContextResult {
        const resolved = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
        
        if (tier === 'L0') {
            return {
                tier: 'L0',
                content: `// [L0] Skipped: ${path.basename(resolved)}`,
                tokens: Math.ceil((path.basename(resolved).length + 20) / 4)
            };
        }

        let content = '';
        try {
            content = fs.readFileSync(resolved, 'utf-8');
        } catch {
            return { tier: 'L0', content: `// unreadable: ${path.basename(resolved)}`, tokens: 0 };
        }

        if (tier === 'L2') {
            return {
                tier: 'L2',
                content,
                tokens: Math.ceil(content.length / 4)
            };
        }

        // L1: Outline
        const ext = path.extname(resolved).toLowerCase();
        if (['.ts', '.js', '.tsx', '.jsx'].includes(ext)) {
            const outline = this.generateOutline(content);
            return {
                tier: 'L1',
                content: outline,
                tokens: Math.ceil(outline.length / 4)
            };
        }

        // Non-code files get first 50 lines for L1
        const lines = content.split('\n');
        const preview = lines.slice(0, 50).join('\n') + (lines.length > 50 ? '\n... [truncated]' : '');
        return {
            tier: 'L1',
            content: preview,
            tokens: Math.ceil(preview.length / 4)
        };
    }

    private generateOutline(content: string): string {
        const lines = content.split('\n');
        const outlineLines: string[] = [];
        const pattern = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum|import)/;
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (pattern.test(trimmed) || trimmed.startsWith('}')) {
                outlineLines.push(line);
            }
        }
        
        return outlineLines.length > 0 ? outlineLines.join('\n') : content.slice(0, 500) + '...';
    }
}
