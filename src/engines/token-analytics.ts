import Database from 'better-sqlite3';
import { MemoryEngine } from './memory';

export interface LifetimeTokenReport {
    totalSessions: number;
    totalEvents: number;
    totalFilesProcessed: number;
    totalTokensOptimized: number;
    totalTokensSaved: number;
    totalTokensForwarded: number;
    overallCompressionRatio: number;
    totalUsdSaved: number;
}

export interface SessionSummaryReport {
    sessionId: string;
    timestamp: number;
    events: number;
    tokensOptimized: number;
    tokensSaved: number;
    tokensForwarded: number;
    compressionRatio: number;
    fileCount: number;
    usdValueSaved: number;
}

export class TokenAnalyticsEngine {
    private db: Database.Database;

    constructor(memoryEngine: MemoryEngine) {
        this.db = memoryEngine.db;
    }

    /**
     * Compute lifetime optimization aggregates.
     */
    getLifetimeReport(): LifetimeTokenReport {
        const stmt = this.db.prepare(`
            SELECT 
                COUNT(DISTINCT session_id) as totalSessions,
                COUNT(id) as totalEvents,
                SUM(file_count) as totalFilesProcessed,
                SUM(tokens_optimized) as totalTokensOptimized,
                SUM(tokens_saved) as totalTokensSaved,
                SUM(tokens_forwarded) as totalTokensForwarded,
                SUM(usd_value_saved) as totalUsdSaved
            FROM token_ledger
        `);
        const row = stmt.get() as any;
        
        const optimized = row.totalTokensOptimized ?? 0;
        const saved = row.totalTokensSaved ?? 0;
        const overallCompressionRatio = optimized > 0 ? saved / optimized : 0;

        return {
            totalSessions: row.totalSessions ?? 0,
            totalEvents: row.totalEvents ?? 0,
            totalFilesProcessed: row.totalFilesProcessed ?? 0,
            totalTokensOptimized: optimized,
            totalTokensSaved: saved,
            totalTokensForwarded: row.totalTokensForwarded ?? 0,
            overallCompressionRatio,
            totalUsdSaved: row.totalUsdSaved ?? 0,
        };
    }

    /**
     * Get rolled-up reporting for recent sessions.
     */
    getSessionHistory(limit: number = 10): SessionSummaryReport[] {
        const stmt = this.db.prepare(`
            SELECT 
                session_id as sessionId,
                MAX(timestamp) as timestamp,
                COUNT(id) as events,
                SUM(tokens_optimized) as tokensOptimized,
                SUM(tokens_saved) as tokensSaved,
                SUM(tokens_forwarded) as tokensForwarded,
                SUM(file_count) as fileCount,
                SUM(usd_value_saved) as usdValueSaved
            FROM token_ledger
            GROUP BY session_id
            ORDER BY timestamp DESC
            LIMIT ?
        `);
        
        const rows = stmt.all(limit) as any[];
        
        return rows.map(r => ({
            sessionId: r.sessionId,
            timestamp: r.timestamp,
            events: r.events,
            tokensOptimized: r.tokensOptimized ?? 0,
            tokensSaved: r.tokensSaved ?? 0,
            tokensForwarded: r.tokensForwarded ?? 0,
            compressionRatio: (r.tokensOptimized ?? 0) > 0 ? (r.tokensSaved ?? 0) / (r.tokensOptimized ?? 0) : 0,
            fileCount: r.fileCount ?? 0,
            usdValueSaved: r.usdValueSaved ?? 0
        }));
    }

    /**
     * Optional: Clear ledger
     */
    clearLedger(): void {
        this.db.prepare('DELETE FROM token_ledger').run();
    }
}
