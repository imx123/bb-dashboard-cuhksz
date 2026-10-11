import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const node = process.execPath;
const electronCli = join(root, 'node_modules', 'electron', 'cli.js');
const harness = join(root, 'scripts', 'verify-classic-login-harness.cjs');
const reportPath = join(root, 'docs', 'qa', 'cuhksz-login-e2e.json');

function run(mode, home) {
  return new Promise(resolveResult => {
    const env = { ...process.env, LMS_HOME: home, LOGIN_E2E_MODE: mode, ELECTRON_ENABLE_LOGGING: '1', ELECTRON_ENABLE_STACK_DUMPING: '1' };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
    const child = spawn(node, [electronCli, harness], {
      cwd: root,
      env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill(), 90_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ mode, code, signal, stdout: stdout.slice(-12_000), stderr: stderr.slice(-12_000) });
    });
    child.on('error', error => {
      clearTimeout(timeout);
      resolveResult({ mode, code: null, signal: null, stdout, stderr: `${stderr}${error.stack || error}` });
    });
  });
}

await mkdir(join(root, '.work'), { recursive: true });
await mkdir(join(root, 'docs', 'qa'), { recursive: true });
const liveHome = join(root, '.work', `login-debug-live-${Date.now()}`);
const mockHome = join(root, '.work', `login-debug-mock-${Date.now()}`);
await mkdir(liveHome, { recursive: true });
await mkdir(mockHome, { recursive: true });

const live = await run('live', liveHome);
const mock = await run('mock', mockHome);
const productionStartScript = await readFile(join(root, 'Start-CUHK-Classic.cmd'), 'utf8');
const report = {
  generatedAt: new Date().toISOString(),
  harness,
  isolatedHomes: [liveHome, mockHome],
  productionEntryUsesNoNoSandbox: !/--no-sandbox/i.test(productionStartScript),
  isolatedHomesRetainedForInspection: true,
  live,
  mock,
  schoolCredentialsUsed: false,
  realSchoolAuthentication: 'BLOCKED: no account, password, cookie, token, or MFA was used',
};
await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));

if (live.code !== 0 || mock.code !== 0) process.exitCode = 1;
