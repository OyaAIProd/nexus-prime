import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { ensureBootstrap } from './engines/client-bootstrap.js';
import { printASCIILogo, printBootSuccessMessage } from './utils/ascii-art.js';

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

async function runWithRetry(maxRetries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (process.env.NEXUS_BOOTSTRAP_DISABLE === '1') {
        appendInstallLog('Bootstrap disabled via NEXUS_BOOTSTRAP_DISABLE=1');
        process.exit(0);
      }

      // Show ASCII art during installation (non-silent mode)
      if (process.env.CI !== 'true' && !process.env.NEXUS_SILENT_INSTALL) {
        console.log('');
        printASCIILogo(version);
      }

      ensureBootstrap({
        packageRoot,
        workspaceRoot: process.cwd(),
        phase: 'install',
        silent: true,
      });

      // Show success message
      if (process.env.CI !== 'true' && !process.env.NEXUS_SILENT_INSTALL) {
        printBootSuccessMessage(version);
      }

      appendInstallLog(`Bootstrap complete (workspace: ${process.cwd()})`);
      return;
    } catch (error) {
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
