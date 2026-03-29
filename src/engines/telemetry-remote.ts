/**
 * Remote Telemetry Engine
 *
 * Privacy-first telemetry for nexus-prime. DEFAULT: OFF.
 * No data leaves the machine until user explicitly opts in.
 *
 * When opted in, sends only aggregate metrics:
 * - Install UUID, OS, node version, nexus version
 * - Session counts, feature usage counts, token savings totals
 * - NEVER: code, prompts, file contents, file paths, project names
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TelemetryEvent {
  type: string;
  timestamp: number;
  installId: string;
  data: Record<string, unknown>;
}

export interface TelemetryConsent {
  optedIn: boolean;
  timestamp: number;
  version: string;
}

export interface TelemetryStats {
  installId: string;
  optedIn: boolean;
  queuedEvents: number;
  totalSessionsTracked: number;
  totalTokensSaved: number;
  totalFeatureUses: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const NEXUS_STATE_DIR = path.join(os.homedir(), '.nexus-prime');
const INSTALL_ID_PATH = path.join(NEXUS_STATE_DIR, 'install-id');
const CONSENT_PATH = path.join(NEXUS_STATE_DIR, 'telemetry-consent');
const QUEUE_PATH = path.join(NEXUS_STATE_DIR, 'telemetry-queue.json');
const MAX_QUEUE_SIZE = 500;
const FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ─────────────────────────────────────────────────────────────────────────────
// RemoteTelemetry
// ─────────────────────────────────────────────────────────────────────────────

export class RemoteTelemetry {
  private installId: string;
  private optedIn: boolean;
  private endpoint: string;
  private queue: TelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private sessionCount = 0;
  private tokensSaved = 0;
  private featureUses = 0;

  constructor(options?: { endpoint?: string }) {
    this.endpoint = options?.endpoint
      ?? process.env.NEXUS_TELEMETRY_ENDPOINT
      ?? '';
    this.installId = this.getOrCreateUUID();
    this.optedIn = this.loadConsentState();
    this.loadQueue();
    this.startFlushTimer();
  }

  // ── UUID Management ──────────────────────────────────────────────────────

  getOrCreateUUID(): string {
    try {
      if (fs.existsSync(INSTALL_ID_PATH)) {
        const id = fs.readFileSync(INSTALL_ID_PATH, 'utf8').trim();
        if (id.length >= 32) return id;
      }
    } catch { /* create new */ }

    const uuid = crypto.randomUUID();
    try {
      if (!fs.existsSync(NEXUS_STATE_DIR)) {
        fs.mkdirSync(NEXUS_STATE_DIR, { recursive: true });
      }
      fs.writeFileSync(INSTALL_ID_PATH, uuid, 'utf8');
    } catch {
      // best effort
    }
    return uuid;
  }

  getInstallId(): string {
    return this.installId;
  }

  // ── Consent Management ───────────────────────────────────────────────────

  isOptedIn(): boolean {
    // Environment override takes precedence
    const envOverride = process.env.NEXUS_TELEMETRY;
    if (envOverride === 'on') return true;
    if (envOverride === 'off') return false;
    return this.optedIn;
  }

  setOptIn(value: boolean): void {
    this.optedIn = value;
    if (!value) {
      this.queue = [];
      this.persistQueue();
    }
    const consent: TelemetryConsent = {
      optedIn: value,
      timestamp: Date.now(),
      version: '1.0',
    };
    try {
      fs.writeFileSync(CONSENT_PATH, JSON.stringify(consent, null, 2), 'utf8');
    } catch { /* best effort */ }
  }

  private loadConsentState(): boolean {
    try {
      if (fs.existsSync(CONSENT_PATH)) {
        const data = JSON.parse(fs.readFileSync(CONSENT_PATH, 'utf8')) as TelemetryConsent;
        return data.optedIn === true;
      }
    } catch { /* default to off */ }
    return false;
  }

  // ── Event Tracking ───────────────────────────────────────────────────────

  trackInstall(): void {
    this.enqueue({
      type: 'install',
      timestamp: Date.now(),
      installId: this.installId,
      data: {
        os: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
        nexusVersion: this.getNexusVersion(),
      },
    });
  }

  trackSessionStart(projectId?: string): void {
    this.sessionCount++;
    this.enqueue({
      type: 'session_start',
      timestamp: Date.now(),
      installId: this.installId,
      data: {
        sessionNumber: this.sessionCount,
        // Note: projectId is hashed for privacy — we only see that it's distinct, not what it is
        projectHash: projectId ? crypto.createHash('sha256').update(projectId).digest('hex').slice(0, 12) : undefined,
      },
    });
  }

  trackFeatureUsage(feature: string, metadata?: Record<string, unknown>): void {
    this.featureUses++;
    this.enqueue({
      type: 'feature_use',
      timestamp: Date.now(),
      installId: this.installId,
      data: {
        feature,
        // Only include safe metadata (no code, no paths, no prompts)
        ...(metadata ? { count: metadata.count, savings: metadata.savings } : {}),
      },
    });
  }

  trackTokenSavings(savings: number): void {
    this.tokensSaved += savings;
    this.enqueue({
      type: 'token_savings',
      timestamp: Date.now(),
      installId: this.installId,
      data: {
        savings,
        lifetimeSavings: this.tokensSaved,
      },
    });
  }

  // ── Queue Management ─────────────────────────────────────────────────────

  private enqueue(event: TelemetryEvent): void {
    if (!this.isOptedIn()) return; // Don't collect without consent
    this.queue.push(event);
    if (this.queue.length > MAX_QUEUE_SIZE) {
      this.queue = this.queue.slice(-MAX_QUEUE_SIZE);
    }
    this.persistQueue();
  }

  private persistQueue(): void {
    try {
      fs.writeFileSync(QUEUE_PATH, JSON.stringify(this.queue), 'utf8');
    } catch { /* best effort */ }
  }

  private loadQueue(): void {
    try {
      if (fs.existsSync(QUEUE_PATH)) {
        this.queue = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
      }
    } catch {
      this.queue = [];
    }
  }

  // ── Flush (send to remote) ───────────────────────────────────────────────

  async flush(): Promise<{ sent: number; error?: string }> {
    if (!this.isOptedIn()) {
      return { sent: 0, error: 'Telemetry is disabled (opt-in required)' };
    }
    if (!this.endpoint) {
      return { sent: 0, error: 'No telemetry endpoint configured (set NEXUS_TELEMETRY_ENDPOINT)' };
    }
    if (this.queue.length === 0) {
      return { sent: 0 };
    }

    const batch = [...this.queue];
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installId: this.installId,
          events: batch,
          sentAt: Date.now(),
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        // Remove sent events from queue
        this.queue = this.queue.slice(batch.length);
        this.persistQueue();
        return { sent: batch.length };
      } else {
        return { sent: 0, error: `HTTP ${response.status}` };
      }
    } catch (err: any) {
      return { sent: 0, error: err?.message ?? 'Network error' };
    }
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => { /* silent */ });
    }, FLUSH_INTERVAL_MS);
    // Don't keep process alive just for telemetry
    if (this.flushTimer && typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref();
    }
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  getStats(): TelemetryStats {
    return {
      installId: this.installId,
      optedIn: this.isOptedIn(),
      queuedEvents: this.queue.length,
      totalSessionsTracked: this.sessionCount,
      totalTokensSaved: this.tokensSaved,
      totalFeatureUses: this.featureUses,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private getNexusVersion(): string {
    try {
      const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return pkg.version || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Clean shutdown */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.persistQueue();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let _sharedTelemetry: RemoteTelemetry | null = null;

export function getSharedTelemetry(options?: { endpoint?: string }): RemoteTelemetry {
  if (!_sharedTelemetry) {
    _sharedTelemetry = new RemoteTelemetry(options);
  }
  return _sharedTelemetry;
}
