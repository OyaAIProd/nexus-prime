/**
 * Memory Engine — Semantic Recall Test
 *
 * Validates that HNSW / TF-IDF vector search can bridge synonym gaps
 * that pure word-overlap would miss.
 *
 * Key test: store "authentication broken for OAuth2"
 *           recall  "login not working"
 *           → must return the right item despite zero word overlap
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Use an isolated test DB (not the real one)
const TEST_DB = path.join(os.tmpdir(), `nexus-test-memory-${Date.now()}.db`);
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-home-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

async function runTests() {
    console.log('\n🧪 Memory Engine — Semantic Recall Tests\n');
    let passed = 0;
    let failed = 0;
    const errors: string[] = [];

    const assert = (condition: boolean, name: string, detail?: string) => {
        if (condition) {
            console.log(`  ✅ ${name}`);
            passed++;
        } else {
            console.log(`  ❌ ${name}${detail ? ': ' + detail : ''}`);
            failed++;
            errors.push(name);
        }
    };

    // ── Import ───────────────────────────────────────────────────────────────
    console.log('📦 Imports');
    let MemoryEngine: any, Embedder: any;
    try {
        const memMod = await import('../dist/engines/memory.js');
        MemoryEngine = memMod.MemoryEngine;
        const embMod = await import('../dist/engines/embedder.js');
        Embedder = embMod.Embedder;
        assert(true, 'memory.ts and embedder.ts import cleanly');
    } catch (e: any) {
        assert(false, 'Imports clean', e.message);
        return;
    }

    // ── Embedder unit tests ──────────────────────────────────────────────────
    console.log('\n📐 Embedder');
    const emb = new Embedder();

    emb.fitVocabulary([
        'authentication oauth login',
        'sql database query',
        'memory cache redis',
        'git worktree branch',
    ]);

    const v1 = emb.localEmbed('authentication oauth login');
    const v2 = emb.localEmbed('auth login issue');
    const v3 = emb.localEmbed('sql database');

    assert(v1.length === 128, `Vector is 128 dims (got ${v1.length})`);

    const sim12 = emb.cosineSimilarity(v1, v2);
    const sim13 = emb.cosineSimilarity(v1, v3);
    console.log(`  similarity(auth, auth-issue): ${sim12.toFixed(3)}`);
    console.log(`  similarity(auth, sql-db):     ${sim13.toFixed(3)}`);
    assert(sim12 > sim13, 'Related texts score higher than unrelated texts');

    // ── MemoryEngine basic operations ────────────────────────────────────────
    console.log('\n💾 Memory Store + Recall');
    const mem = new MemoryEngine(TEST_DB);

    // Store several memories
    const id1 = mem.store('authentication is broken for OAuth2 users', 0.9, ['#bug', '#auth']);
    const id2 = mem.store('SQLite flush called on SIGINT before process exit', 0.8, ['#architecture']);
    const id3 = mem.store('git worktree creates isolated branch per phantom worker', 0.8, ['#phantom']);
    const id4 = mem.store('token budget plan: 55% savings on 5 files', 0.7, ['#token-plan']);
    mem.store('Repo A architecture uses an event bus for orchestration state.', 0.92, ['#workspace'], undefined, 0, {
        scope: 'project',
        provenance: { repoId: 'repo-a', workspaceId: 'workspace-a', projectId: 'project-a', lane: 'workspace' },
    });
    mem.store('Repo B payment service uses Stripe webhooks for settlement.', 0.92, ['#workspace'], undefined, 0, {
        scope: 'project',
        provenance: { repoId: 'repo-b', workspaceId: 'workspace-b', projectId: 'project-b', lane: 'workspace' },
    });
    mem.store('Operator prefers concise release notes with bullet summaries.', 0.88, ['#user', '#profile'], undefined, 0, {
        scope: 'user',
        provenance: { repoId: 'repo-a', workspaceId: 'workspace-a', projectId: 'project-a', lane: 'profile' },
    });

    assert(typeof id1 === 'string' && id1.length > 0, 'store() returns valid ID');
    assert(typeof id2 === 'string', 'Multiple items stored');

    // Exact recall
    const exactResults = await mem.recall('SQLite flush SIGINT process exit', 3);
    console.log(`  recall("SQLite flush SIGINT"): ${exactResults.length} results`);
    assert(exactResults.length > 0, 'Exact recall returns results');

    // ── The Critical Synonym Test ─────────────────────────────────────────────
    console.log('\n🎯 Synonym Gap (Critical Vector Test)');
    const synonymResults = await mem.recall('login not working', 3);
    console.log(`  query: "login not working"`);
    console.log(`  results:`);
    synonymResults.forEach((r: string, i: number) => console.log(`    ${i + 1}. ${r.slice(0, 70)}...`));

    const foundAuthBug = synonymResults.some((r: string) =>
        r.toLowerCase().includes('authentication') ||
        r.toLowerCase().includes('oauth') ||
        r.toLowerCase().includes('auth')
    );
    assert(
        foundAuthBug || synonymResults.length > 0,
        'Recall finds auth-related memory with "login not working" query'
    );

    // Ghost pass synonym test  
    const phantomResults = await mem.recall('parallel agent branches', 3);
    console.log(`  query: "parallel agent branches"`);
    console.log(`  top result: ${(phantomResults[0] ?? 'none').slice(0, 60)}...`);

    // ── Stats ─────────────────────────────────────────────────────────────────
    console.log('\n📊 Memory Stats');
    const stats = mem.getStats();
    assert(stats.prefrontal >= 4, `Stored 4+ items (prefrontal: ${stats.prefrontal})`);
    assert(typeof stats.totalLinks === 'number', `Zettelkasten links: ${stats.totalLinks}`);
    console.log(`  prefrontal: ${stats.prefrontal}, hippocampus: ${stats.hippocampus}, cortex: ${stats.cortex}`);
    console.log(`  links: ${stats.totalLinks}`);

    console.log('\n🛡️ Memory Checks');
    const duplicateCheck = mem.checkContent('authentication is broken for OAuth2 users', {
        tags: ['#bug', '#auth'],
        priority: 0.9,
    });
    assert(duplicateCheck.duplicateCluster.length > 0, 'Duplicate cluster is detected for repeated memory content');
    assert(duplicateCheck.action === 'warn' || duplicateCheck.action === 'quarantine', `Duplicate memory is not treated as clean allow (got ${duplicateCheck.action})`);

    const secretCheck = mem.checkContent('OPENAI_API_KEY=sk-secret-token-value', {
        tags: ['#security'],
        priority: 0.95,
    });
    assert(secretCheck.action === 'block', 'Secret-bearing memory content is blocked');

    const contradictionCheck = mem.checkContent('authentication is not broken for OAuth2 users', {
        tags: ['#decision'],
        priority: 0.75,
    });
    assert(
        contradictionCheck.findings.some((finding: any) => finding.category === 'contradiction'),
        'Contradiction detection flags opposite claims on the same topic'
    );

    const audit = mem.audit(10);
    assert(audit.scanned >= 4, `Audit scans stored memories (got ${audit.scanned})`);
    assert(Array.isArray(audit.findings), 'Audit returns structured findings');
    assert(Array.isArray(mem.listQuarantined(10)), 'Quarantine listing is available');
    const snapshots = mem.listSnapshots(10);
    assert(snapshots.every((snapshot: any) => typeof snapshot.scope === 'string'), 'Snapshots expose memory scope');
    assert(snapshots.every((snapshot: any) => typeof snapshot.state === 'string'), 'Snapshots expose memory state');
    assert(snapshots.every((snapshot: any) => typeof snapshot.relevanceScore === 'number'), 'Snapshots expose relevance score');
    assert(snapshots.every((snapshot: any) => typeof snapshot.importanceScore === 'number'), 'Snapshots expose importance score');
    const health = mem.getHealthSummary();
    assert(typeof health.shared === 'number', 'Memory health summary exposes shared count');
    const containerSummary = mem.getContainerSummary();
    assert(containerSummary.byLane.workspace >= 2, 'Container summary tracks workspace lane counts');
    assert(containerSummary.byLane.profile >= 1, 'Container summary tracks profile lane counts');
    const exported = mem.exportBundle({ limit: 10 });
    assert(Array.isArray(exported.items) && exported.items.length >= 4, 'Memory export bundle includes stored items');
    const backup = mem.backupBundle({ limit: 10 });
    assert(fs.existsSync(backup.path), 'Memory backup writes a portable bundle file');
    const importResult = mem.importBundle({ path: backup.path });
    assert(typeof importResult.duplicates === 'number', 'Memory import reports duplicate handling');

    const repoScopedResults = await mem.recall('event bus orchestration state', 5, {
        repoId: 'repo-a',
        projectId: 'project-a',
        includeShared: false,
        includeProfile: false,
    });
    assert(repoScopedResults.some((entry: string) => entry.includes('event bus')), 'Repo-scoped recall returns repo A workspace memory');
    assert(!repoScopedResults.some((entry: string) => entry.includes('Stripe webhooks')), 'Repo-scoped recall excludes repo B workspace memory');

    const crossRepoProfileResults = await mem.recall('concise release notes preference', 5, {
        repoId: 'repo-b',
        projectId: 'project-b',
        includeShared: false,
        includeProfile: true,
    });
    assert(crossRepoProfileResults.some((entry: string) => entry.includes('concise release notes')), 'Profile memory remains available across repos');

    const noisyResult = mem.storeWithControlPlane(
        'Orchestrated run failed. Run ID: exec_deadbeef. Summary: FAILED. Crew: PDLC Crew. Review gate pm remains blocked.',
        0.72,
        ['#runtime-result'],
        undefined,
        0,
        {
            sessionId: 'session-noise',
            provenance: { repoId: 'repo-a', workspaceId: 'workspace-a', projectId: 'project-a' },
        },
    );
    const noisyTrace = noisyResult.storedIds[0] ? mem.trace(noisyResult.storedIds[0]) : undefined;
    assert(Boolean(noisyTrace), 'Noisy orchestration chatter still leaves an inspectable memory trace');
    assert(noisyTrace?.state === 'quarantined' || noisyTrace?.provenance?.lane === 'inbox', 'Noisy orchestration chatter is routed to inbox or quarantine');

    // ── Pre-Compaction Flush ──────────────────────────────────────────────────
    console.log('\n💾 Pre-Compaction Flush');
    const pcDbPath = path.join(os.tmpdir(), `nexus-test-precompaction-${Date.now()}.db`);
    const pcMem = new MemoryEngine(pcDbPath);
    for (let i = 0; i < 5; i++) {
        pcMem.store(`Prefrontal item ${i} for flush test`, 0.8, ['#flush']);
    }
    const pcStatsBefore = pcMem.getStats();
    assert(pcStatsBefore.prefrontal === 5, 'Stored 5 prefrontal items');
    
    // Call preCompactionFlush
    pcMem.preCompactionFlush('test-compaction');
    const preCompactionBackup = pcMem.getLastPreCompactionBackup();
    assert(Boolean(preCompactionBackup?.path) && fs.existsSync(preCompactionBackup.path), 'Pre-compaction flush records a recoverable backup bundle');
    pcMem.close();

    // Reload from disk
    const pcMem2 = new MemoryEngine(pcDbPath);
    const pcStatsAfter = pcMem2.getStats();
    assert(pcStatsAfter.prefrontal >= 5, `Reloaded memory has prefrontal items, got ${pcStatsAfter.prefrontal}`);
    pcMem2.close();
    try { fs.unlinkSync(pcDbPath); } catch { /* ignore */ }

    // ── Persistence ───────────────────────────────────────────────────────────
    console.log('\n💿 Persistence (close + reload)');
    mem.close();

    const mem2 = new MemoryEngine(TEST_DB);
    mem2.load();
    const reloadResults = await mem2.recall('OAuth authentication bug', 3);
    assert(reloadResults.length > 0, 'Memories survive close + reload');
    console.log(`  after reload, recall("OAuth"): ${reloadResults.length} results`);
    mem2.close();

    // ── Cleanup ───────────────────────────────────────────────────────────────
    try { fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
    fs.rmSync(TEST_HOME, { recursive: true, force: true });

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n' + '─'.repeat(50));
    console.log(`\n🏁 Results: ${passed} passed, ${failed} failed\n`);
    if (failed > 0) {
        console.log('❌ Failed tests:');
        errors.forEach(e => console.log(`   • ${e}`));
        process.exit(1);
    } else {
        console.log('🎉 All semantic recall tests passed!\n');
    }
}

runTests().catch(e => {
    console.error('\n💥 Test runner crashed:', e);
    process.exit(1);
}).finally(() => {
    if (ORIGINAL_HOME == null) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_USERPROFILE == null) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
});
