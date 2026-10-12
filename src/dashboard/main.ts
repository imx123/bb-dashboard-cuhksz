import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit CLI authorization remains available to the retained MCP tooling.
// Ordinary Electron launches always open the CUHK(SZ) Dashboard.
if (process.argv.includes('--from-cli')) {
  void import('../auth/app.js').catch(() => app.exit(1));
} else {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  process.env.LMS_HOME = resolve(process.env.CUHK_LMS_HOME || process.env.LMS_HOME ||
    (app.isPackaged ? join(app.getPath('appData'), 'bb-dashboard-cuhksz') : join(projectRoot, '.cuhk-data')));
  process.env.LMS_UPDATE_CHECK = '0';
  process.env.CUHK_CLASSIC_MODE ??= 'live';
  const browserHome = join(process.env.LMS_HOME, 'browser');
  mkdirSync(browserHome, { recursive: true, mode: 0o700 });
  app.setPath('userData', browserHome);
  app.setPath('sessionData', browserHome);
  // Do not await app.whenReady() during entry-module evaluation.
  void import('./app.js').then(module => module.startDashboard()).catch(async error => {
    const { debugLog } = await import('../debug-log.js');
    debugLog.event('dashboard.boot.failed', { errorType: error instanceof Error ? error.name : 'UnknownError' });
    await debugLog.flush();
    app.exit(1);
  });
}
