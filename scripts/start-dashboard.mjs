import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
if (existsSync(new URL('../src/dashboard/main.ts', import.meta.url))) {
  const build = spawnSync(process.execPath, [fileURLToPath(new URL('./build.mjs', import.meta.url))], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
if (!existsSync(new URL('../dist/src/dashboard/main.js', import.meta.url))) {
  console.error('Dashboard entry is missing. Run npm run build in the source checkout.');
  process.exit(1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
env.CUHK_CLASSIC_MODE = process.argv.includes('--fixture') ? 'offline-fixture' : 'live';
const child = spawn(require('electron'), [root], { cwd: root, env, stdio: 'inherit' });
child.once('error', error => { console.error(`Dashboard launch failed: ${error.message}`); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
