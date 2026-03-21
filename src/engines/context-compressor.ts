/**
 * Context Compressor Engine
 * 
 * Implements attention-weighted background context compaction.
 * Analyzes large text payloads and compresses them by retaining only
 * high-attention lines (code structures, keywords, core logic) while
 * stripping boilerplate, empty lines, and low-information content.
 */

export interface CompressionOptions {
    targetRatio?: number; // 0.0 to 1.0 (e.g. 0.5 means compress to 50% size)
    maxTokens?: number;   // Maximum tokens allowed in the output
}

export interface CompressionStats {
    originalTokens: number;
    compressedTokens: number;
    ratio: number;
}

export class ContextCompressor {
    constructor() {}

    /**
     * Compresses text using an attention-weighted line-selection algorithm.
     */
    public compress(text: string, options: CompressionOptions = {}): { compressedText: string; stats: CompressionStats } {
        const lines = text.split('\n');
        
        const originalTokens = Math.ceil(text.length / 4);
        let targetTokens = originalTokens;
        
        if (options.maxTokens) {
            targetTokens = options.maxTokens;
        } else if (options.targetRatio) {
            targetTokens = Math.floor(originalTokens * options.targetRatio);
        }
        
        // If no compression needed, return original
        if (targetTokens >= originalTokens) {
            return {
                compressedText: text,
                stats: { originalTokens, compressedTokens: originalTokens, ratio: 1.0 }
            };
        }

        // Score lines
        const scoredLines = lines.map((line, index) => ({
            index,
            text: line,
            score: this.scoreLineAttention(line),
            length: line.length
        }));

        // Sort by attention score (descending)
        const sortedByAttention = [...scoredLines].sort((a, b) => b.score - a.score);

        // Greedily pick lines until we hit the budget
        // Leave room for 1 placeholder (approx ~15 tokens)
        let currentTokens = 15; 
        const selectedIndices = new Set<number>();
        
        // Always try to keep the first and last line to maintain structural context, if budget allows
        if (lines.length > 0) {
            const t0 = Math.ceil(lines[0].length / 4);
            if (currentTokens + t0 <= targetTokens) {
                selectedIndices.add(0);
                currentTokens += t0;
            }
        }
        if (lines.length > 1) {
            const tLast = Math.ceil(lines[lines.length - 1].length / 4);
            if (currentTokens + tLast <= targetTokens) {
                selectedIndices.add(lines.length - 1);
                currentTokens += tLast;
            }
        }

        for (const line of sortedByAttention) {
            if (selectedIndices.has(line.index)) continue;
            
            const tokens = Math.ceil(line.length / 4);
            if (currentTokens + tokens <= targetTokens) {
                selectedIndices.add(line.index);
                currentTokens += tokens;
            } else if (currentTokens >= targetTokens) {
                break;
            }
        }

        // Reconstruct text in original order, inserting summary placeholders for skipped chunks
        const resultLines: string[] = [];
        let skips = 0;
        
        for (let i = 0; i < lines.length; i++) {
            if (selectedIndices.has(i)) {
                if (skips > 0) {
                    resultLines.push(`// ...[${skips} lines omitted]`);
                    skips = 0;
                }
                resultLines.push(lines[i]);
            } else {
                skips++;
            }
        }
        
        if (skips > 0) {
            resultLines.push(`// ...[${skips} lines omitted]`);
        }

        const compressedText = resultLines.join('\n');
        const compressedTokens = Math.ceil(compressedText.length / 4);
        
        return {
            compressedText,
            stats: {
                originalTokens,
                compressedTokens,
                ratio: compressedTokens / Math.max(1, originalTokens)
            }
        };
    }

    /**
     * Scores a line based on structural features and keyword density.
     */
    private scoreLineAttention(line: string): number {
        const trimmed = line.trim();
        
        // Empty lines have zero attention
        if (trimmed.length === 0) return 0;

        let score = 1.0; // Base presence score

        // Syntax boundaries get high attention
        if (/^(public|private|protected|static|abstract|class|function|export|import|const|let|var|interface|type)\b/.test(trimmed)) {
            score += 5.0;
        }

        // Control flow keywords
        if (/\b(if|else|return|for|while|switch|case|break|continue)\b/.test(trimmed)) {
            score += 2.0;
        }

        // Structural brackets
        if (/^[{}()[\]]+$/.test(trimmed)) {
            score += 1.5;
        }

        // Comments get lower attention weight
        if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
            score *= 0.3;
        }

        // Extremely long lines (e.g. minified code or large strings) are usually low signal density per char
        if (trimmed.length > 200) {
            score *= (200 / trimmed.length);
        }

        return score;
    }
}
