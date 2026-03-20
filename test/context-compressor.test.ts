import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextCompressor } from '../src/engines/context-compressor.js';

test('ContextCompressor - attention-weighted compression', async (t) => {
    const compressor = new ContextCompressor();

    await t.test('compresses boilerplate and keeps structural lines', () => {
        const input = `
import { stuff } from 'somewhere';

export class MyImportantClass {
    // This is a giant block of useless comments
    // that should be scored very low
    // and easily compressed away
    // blah blah blah
    // blah blah blah
    // blah blah blah
    
    public doWork(): void {
        const x = 1;
        if (x === 1) {
            console.log("Important logic");
            return;
        }
    }
}
        `.trim();

        const result = compressor.compress(input, { targetRatio: 0.5 });
        
        assert.ok(result.stats.compressedTokens < result.stats.originalTokens, 'Should reduce token count');
        assert.ok(result.stats.ratio <= 0.70, `Should hit target ratio roughly, got ratio ${result.stats.ratio}`);
        assert.match(result.compressedText, /export class MyImportantClass/, 'Keeps class definition');
        assert.match(result.compressedText, /public doWork/, 'Keeps function definition');
        assert.match(result.compressedText, /if \(x === 1\)/, 'Keeps control flow');
        assert.match(result.compressedText, /\/\/ \.\.\.\[/, 'Inserts compression placeholder');
    });

    await t.test('compresses down to max tokens', () => {
        const input = Array(100).fill('console.log("boring repetitive log");').join('\n');
        
        const maxTokens = 20; // very small budget
        const result = compressor.compress(input, { maxTokens });
        
        assert.ok(result.stats.compressedTokens <= maxTokens + 10, `Should respect max tokens constraint, got ${result.stats.compressedTokens}`);
        assert.ok(result.compressedText.includes('// ...['), 'Should indicate missing lines');
    });

    await t.test('bypasses compression if target ratio is 1.0', () => {
        const input = `const a = 1;`;
        const result = compressor.compress(input, { targetRatio: 1.0 });
        assert.equal(result.compressedText, input);
        assert.equal(result.stats.ratio, 1.0);
    });
});
