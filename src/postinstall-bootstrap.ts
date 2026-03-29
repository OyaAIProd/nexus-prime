import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { ensureBootstrap } from './engines/client-bootstrap.js';
import { ASCII_ART, printASCIILogo, printBootSuccessMessage } from './utils/ascii-art.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.join(__dirname, '..');

// Get version from package.json
let version = '4.4.0';
try {
  const pkgPath = path.join(packageRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  version = pkg.version || version;
} catch {
  // fallback to default version
}

function appendInstallLog(message: string): void {
  try {
    const logDir = path.join(os.homedir(), '.nexus-prime');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logPath = path.join(logDir, 'install.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logPath, `[${timestamp}] ${message}\n`);
  } catch {
    // Best-effort logging — never fail the install for a log write
  }
}

function shouldShowInstallBanner(): boolean {
  return process.env.CI !== 'true' && !process.env.NEXUS_SILENT_INSTALL;
}

function shouldAnimateInstall(): boolean {
  if (!shouldShowInstallBanner()) return false;
  return Boolean(process.stdout.isTTY && process.stderr.isTTY);
}

function startInstallSpinner(): { stop: (message?: string) => void } | null {
  if (!shouldAnimateInstall()) return null;

  let frame = 0;
  const frames = Array.isArray(ASCII_ART.sciFiLoaderFrames) && ASCII_ART.sciFiLoaderFrames.length > 0
    ? ASCII_ART.sciFiLoaderFrames
    : [ASCII_ART.sciFiLoader(0)];
  const frameRate = Math.max(60, Number(ASCII_ART.sciFiLoaderFrameRateMs || 90));

  const render = () => {
    const glyph = frames[frame % frames.length];
    process.stderr.write(`\r\x1b[35m${glyph}\x1b[0m`);
    frame += 1;
  };

  render();
  const handle = setInterval(render, frameRate);

  return {
    stop(message = '') {
      clearInterval(handle);
      process.stderr.write('\r\x1b[2K');
      if (message) {
        process.stderr.write(`\r\x1b[32m${message}\x1b[0m\n`);
      }
    },
  };
}

async function runWithRetry(maxRetries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (process.env.NEXUS_BOOTSTRAP_DISABLE === '1') {
        appendInstallLog('Bootstrap disabled via NEXUS_BOOTSTRAP_DISABLE=1');
        process.exit(0);
      }

      // Show ASCII art during installation (non-silent mode)
      if (shouldShowInstallBanner()) {
        console.log('');
        printASCIILogo(version);
      }

      const spinner = startInstallSpinner();
      try {
        ensureBootstrap({
          packageRoot,
          workspaceRoot: process.cwd(),
          phase: 'install',
          silent: true,
        });
        spinner?.stop('✔ bootstrap complete');
      } catch (error) {
        spinner?.stop();
        throw error;
      }

      // Show success message
      if (shouldShowInstallBanner()) {
        printBootSuccessMessage(version);
      }

      // Generate anonymous install UUID for telemetry (opt-in only, no data sent by default)
      try {
        const installIdPath = path.join(os.homedir(), '.nexus-prime', 'install-id');
        if (!fs.existsSync(installIdPath)) {
          const uuid = crypto.randomUUID();
          fs.writeFileSync(installIdPath, uuid, 'utf8');
          appendInstallLog(`Install UUID generated: ${uuid.slice(0, 8)}...`);
        }
      } catch { /* non-fatal */ }

      appendInstallLog(`Bootstrap complete (workspace: ${process.cwd()})`);
      return;
    } catch (error) {
      process.stderr.write('\r\x1b[2K');
      const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
      const isRetryable = code === 'EBUSY' || code === 'EACCES';
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;

      if (isRetryable && attempt < maxRetries) {
        console.warn(`[nexus-prime] Bootstrap encountered ${code}, retrying in ${delayMs}ms (attempt ${attempt}/${maxRetries})...`);
        appendInstallLog(`Retry ${attempt}/${maxRetries}: ${code} — ${message}`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        if (isRetryable) {
            console.error(`[nexus-prime] postinstall bootstrap failed after ${maxRetries} attempts: ${message}`);
        } else {
            console.error(`[nexus-prime] postinstall bootstrap skipped: ${message}`);
        }
        appendInstallLog(`Bootstrap failed: ${message}${stack ? '\n' + stack : ''}`);
        return;
      }
    }
  }
}

runWithRetry().catch(err => {
  console.error('[PostInstall] Bootstrap retry failed:', err?.message ?? err);
  // non-fatal, process may already be exiting
});
