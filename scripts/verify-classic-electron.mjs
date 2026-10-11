import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const node = process.execPath;
const electronCli = join(root, 'node_modules', 'electron', 'cli.js');
const harness = join(root, 'scripts', 'verify-classic-electron-harness.cjs');
const runHome = join(root, '.work', `electron-ui-e2e-home-${Date.now()}`);
const reportPath = join(root, '.work', 'electron-ui-e2e.json');

function run(name, environment) {
  return new Promise(resolveResult => {
    const child = spawn(node, [electronCli, '--no-sandbox', '--disable-gpu', '--disable-gpu-sandbox', '--in-process-gpu', harness], { cwd: root, env: environment, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill(), 60_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ name, code, signal, stdout: stdout.slice(-8000), stderr: stderr.slice(-8000) });
    });
    child.on('error', error => { clearTimeout(timeout); resolveResult({ name, code: null, signal: null, stdout, stderr: `${stderr}${error.stack || error}` }); });
  });
}

await mkdir(runHome, { recursive: true });
const common = {
  ...process.env,
  LMS_HOME: runHome,
  CUHK_CLASSIC_MODE: 'offline-fixture',
  ELECTRON_ENABLE_LOGGING: '1',
  ELECTRON_ENABLE_STACK_DUMPING: '1',
};
const inherited = await run('inherited-ELECTRON_RUN_AS_NODE', { ...common, ELECTRON_RUN_AS_NODE: '1', E2E_PHASE: 'first' });
const clean = { ...common };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete clean[key];
const first = await run('removed-ELECTRON_RUN_AS_NODE-first', { ...clean, E2E_PHASE: 'first' });
const restart = first.code === 0
  ? await run('removed-ELECTRON_RUN_AS_NODE-restart', { ...clean, E2E_PHASE: 'restart' })
  : { name: 'removed-ELECTRON_RUN_AS_NODE-restart', code: null, signal: null, stdout: '', stderr: 'not run because first phase failed' };
const output = {
  removedFromCleanChild: ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH'],
  harness,
  runHome,
  inherited,
  first,
  restart,
};
await writeFile(reportPath, JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
await rm(runHome, { recursive: true, force: true });
if (inherited.code !== 9 || first.code !== 0 || restart.code !== 0) process.exitCode = 1;
