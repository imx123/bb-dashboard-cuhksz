const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { writeFile, mkdir } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = resolve(__dirname, '..');
const mode = process.env.LOGIN_E2E_MODE || 'mock';
const home = resolve(process.env.LMS_HOME || join(root, '.work', 'login-debug-harness'));
const qa = join(root, 'docs', 'qa');

async function waitFor(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

const evaluate = (win, source) => win.webContents.executeJavaScript(source, true);
const click = (win, selector) => evaluate(win, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true; })()`);

function visibleDescendantWindows(parentPid) {
  if (process.platform !== 'win32' || !parentPid) return [];
  const command = [
    `$root = ${Number(parentPid)}`,
    '$all = @(Get-CimInstance Win32_Process)',
    '$ids = [System.Collections.Generic.HashSet[int]]::new()',
    '[void]$ids.Add($root)',
    '$changed = $true',
    'while ($changed) { $changed = $false; foreach ($item in $all) { if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $changed = $true } } }',
    '$rows = @()',
    'foreach ($id in $ids) { try { $p = Get-Process -Id $id -ErrorAction Stop; if ([int64]$p.MainWindowHandle -ne 0) { $rows += [pscustomobject]@{ id = [int]$p.Id; name = [string]$p.ProcessName; handle = [int64]$p.MainWindowHandle; title = [string]$p.MainWindowTitle } } } catch {} }',
    '$rows | ConvertTo-Json -Compress',
  ].join(';');
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function closeIsolatedBrowserWindow(windowInfo) {
  assert.ok(windowInfo?.id, 'no isolated visible browser process was found');
  const id = Number(windowInfo.id);
  assert.ok(Number.isInteger(id) && id > 0, 'isolated browser process id was invalid');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${id} -Force -ErrorAction Stop`], { windowsHide: true });
}

async function saveScreenshot(win, name) {
  await mkdir(qa, { recursive: true });
  const path = join(qa, name);
  const hidden = !win.isVisible();
  if (hidden) {
    win.showInactive();
    await new Promise(resolveDelay => setTimeout(resolveDelay, 150));
  }
  try {
    await writeFile(path, (await win.webContents.capturePage()).toPNG());
  } finally {
    if (hidden) win.hide();
  }
  return path;
}

function liveSnapshot() {
  return {
    state: 'auth-required', fetchedAt: new Date().toISOString(), timezone: 'Asia/Shanghai',
    courses: [], announcements: [], assignments: [], files: [],
    errors: [{ scope: 'auth', code: 'AUTH_REQUIRED', message: '需要在本机完成 Blackboard 登录。' }], source: 'live',
  };
}

function mockProvider() {
  let loginCalls = 0;
  let loads = 0;
  let closeCalls = 0;
  const calls = [];
  const safeAuthResult = {
    phase: 'current-page',
    origin: 'https://bb.cuhk.edu.cn',
    pathname: '/webapps/portal/execute/tabs/tabAction',
    portalTarget: '/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1',
    portalCandidate: false,
    courseLinkCount: 0,
    marker: false,
    iframeCount: 1,
    explicitLoginForm: false,
  };
  const unrecognizedMessage = '页面结构无法确认（phase=current-page; origin=https://bb.cuhk.edu.cn; pathname=/webapps/portal/execute/tabs/tabAction; portalCandidate=false; courseLinks=0; marker=false; iframeCount=1; loginForm=false）';
  const timeoutMessage = '检查连接超时（phase=candidate; origin=https://bb.cuhk.edu.cn; pathname=/webapps/portal/execute/tabs/tabAction; portalCandidate=true; courseLinks=0; marker=false; iframeCount=0; loginForm=false）';
  const provider = {
    snapshot: undefined,
    load: async () => { loads += 1; provider.snapshot = liveSnapshot(); return provider.snapshot; },
    login: async action => {
      loginCalls += 1;
      calls.push(action);
      if (action === 'begin' && loginCalls === 1) return { ok: false, state: 'auth-required', next: 'browser' };
      if (action === 'complete' && loginCalls === 2) return { ok: false, state: 'auth-required', next: 'complete', error: { code: 'AUTH_REQUIRED', message: '官方会话仍未验证', recoverable: true } };
      if (action === 'begin' && loginCalls === 3) return { ok: false, state: 'auth-required', next: 'browser' };
      if (action === 'complete' && loginCalls === 4) return { ok: true, state: 'ok', authenticated: true };
      if (action === 'begin' && loginCalls === 5) return { ok: false, state: 'auth-required', next: 'browser' };
      if (action === 'complete' && loginCalls === 6) return { ok: false, state: 'error', error: { code: 'AUTH_CHECK_UNRECOGNIZED', message: unrecognizedMessage, recoverable: true }, authResult: safeAuthResult };
      if (action === 'complete' && loginCalls === 7) return { ok: false, state: 'error', error: { code: 'TIMEOUT', message: timeoutMessage, recoverable: true }, authResult: { ...safeAuthResult, phase: 'candidate', portalCandidate: true, iframeCount: 0 } };
      return { ok: false, state: 'error', error: { code: 'TIMEOUT', message: timeoutMessage, recoverable: true }, authResult: safeAuthResult };
    },
    close: async () => { closeCalls += 1; },
    get loginCalls() { return loginCalls; },
    get loads() { return loads; },
    get closeCalls() { return closeCalls; },
    get calls() { return calls.slice(); },
  };
  return provider;
}

async function start(provider) {
  const { startDashboard } = await import(pathToFileURL(join(root, 'dist', 'src', 'dashboard', 'app.js')).href);
  await startDashboard({ provider });
  const win = BrowserWindow.getAllWindows().find(item => !item.isDestroyed());
  assert.ok(win, 'dashboard BrowserWindow was not created');
  win.hide();
  await waitFor(() => evaluate(win, `document.getElementById('refresh')?.disabled === false && !document.querySelector('#updated .spinner')`), 'initial dashboard load');
  return win;
}

async function close(win, provider, sidecarPid) {
  try { await provider.close(); } catch { /* close is asserted by the parent process below */ }
  if (sidecarPid) {
    await waitFor(() => visibleDescendantWindows(sidecarPid).length === 0, 'isolated Chromium exit');
    await waitFor(() => {
      try { process.kill(sidecarPid, 0); return false; } catch { return true; }
    }, `Sidecar ${sidecarPid} exit`, 15_000);
  }
  if (!win.isDestroyed()) win.destroy();
}

async function runMock() {
  const provider = mockProvider();
  const win = await start(provider);
  try {
    await click(win, '#login');
    await waitFor(() => evaluate(win, `document.getElementById('notice')?.textContent.includes('浏览器已打开')`), 'browser-pending notice');
    assert.equal(await evaluate(win, `document.getElementById('login')?.textContent`), '我已登录，检查连接');
    const pendingScreenshot = await saveScreenshot(win, 'cuhksz-login-mock-browser-pending.png');

    await click(win, '#login');
    await waitFor(() => evaluate(win, `document.getElementById('notice')?.textContent.includes('AUTH_REQUIRED')`), 'auth-required error envelope');
    assert.equal(await evaluate(win, `document.getElementById('reopen-login')?.hidden`), false);
    const rejectedScreenshot = await saveScreenshot(win, 'cuhksz-login-mock-auth-required.png');

    await click(win, '#reopen-login');
    await waitFor(() => evaluate(win, `document.getElementById('notice')?.textContent.includes('浏览器已打开')`), 'reopen login');
    assert.equal(await evaluate(win, `document.getElementById('login')?.textContent`), '我已登录，检查连接');

    await click(win, '#login');
    await waitFor(() => provider.loads >= 2 && evaluate(win, `document.getElementById('refresh')?.disabled === false && !document.querySelector('#updated .spinner')`), 'successful login refresh');
    assert.equal(provider.loginCalls, 4);
    assert.ok(provider.loads >= 2, 'successful login did not call refresh');

    await click(win, '#login');
    await waitFor(() => evaluate(win, `document.getElementById('notice')?.textContent.includes('浏览器已打开')`), 'begin before auth-check diagnostics');
    assert.equal(await evaluate(win, `document.getElementById('login')?.textContent`), '我已登录，检查连接');
    const closeCallsBeforeUnrecognized = provider.closeCalls;
    await click(win, '#login');
    await waitFor(() => evaluate(win, `document.getElementById('notice')?.textContent.includes('AUTH_CHECK_UNRECOGNIZED')`), 'auth-check-unrecognized diagnostic');
    const unrecognizedNotice = await evaluate(win, `document.getElementById('notice')?.textContent || ''`);
    assert.match(unrecognizedNotice, /phase=current-page/);
    assert.match(unrecognizedNotice, /portalCandidate=false/);
    assert.doesNotMatch(unrecognizedNotice, /[?#]/);
    assert.equal(await evaluate(win, `document.getElementById('login')?.textContent`), '我已登录，检查连接');
    assert.equal(await evaluate(win, `document.getElementById('reopen-login')?.hidden`), false);
    assert.equal(provider.closeCalls, closeCallsBeforeUnrecognized, 'auth-check failure closed the provider');
    assert.equal(provider.calls.at(-1), 'complete', 'auth-check failure unexpectedly called begin');
    const unrecognizedScreenshot = await saveScreenshot(win, 'cuhksz-login-mock-auth-check-unrecognized.png');

    const closeCallsBeforeTimeout = provider.closeCalls;
    await click(win, '#login');
    await waitFor(() => evaluate(win, `document.getElementById('notice')?.textContent.includes('TIMEOUT')`), 'timeout diagnostic');
    const timeoutNotice = await evaluate(win, `document.getElementById('notice')?.textContent || ''`);
    assert.match(timeoutNotice, /phase=candidate/);
    assert.match(timeoutNotice, /portalCandidate=true/);
    assert.doesNotMatch(timeoutNotice, /[?#]/);
    assert.equal(await evaluate(win, `document.getElementById('login')?.textContent`), '我已登录，检查连接');
    assert.equal(await evaluate(win, `document.getElementById('reopen-login')?.hidden`), false);
    assert.equal(provider.closeCalls, closeCallsBeforeTimeout, 'timeout closed the provider');
    assert.equal(provider.calls.at(-1), 'complete', 'timeout unexpectedly called begin');
    const timeoutScreenshot = await saveScreenshot(win, 'cuhksz-login-mock-timeout-retry.png');
    await close(win, provider);
    return { mode: 'mock', loginCalls: provider.loginCalls, loadCalls: provider.loads, closeCallsBeforeCleanup: closeCallsBeforeTimeout, calls: provider.calls, screenshots: [pendingScreenshot, rejectedScreenshot, unrecognizedScreenshot, timeoutScreenshot], authCheckFailuresKeepComplete: true, authCheckFailuresKeepProviderOpen: true, authCheckFailuresUseCompleteAction: true, sidecarExited: true };
  } catch (error) {
    await close(win, provider);
    throw error;
  }
}

async function runLive() {
  const [{ startDashboard }, { ClassicMcpClient, classicUserDataDir }, { ClassicProvider }, { ClassicSnapshotCache }] = await Promise.all([
    import(pathToFileURL(join(root, 'dist', 'src', 'dashboard', 'app.js')).href),
    import(pathToFileURL(join(root, 'dist', 'src', 'classic', 'mcp-client.js')).href),
    import(pathToFileURL(join(root, 'dist', 'src', 'classic', 'provider.js')).href),
    import(pathToFileURL(join(root, 'dist', 'src', 'classic', 'cache.js')).href),
  ]);
  const scope = 'login-debug|https://bb.cuhk.edu.cn|live';
  const client = new ClassicMcpClient({ mode: 'live', userDataDir: classicUserDataDir(scope), connectTimeoutMs: 15_000, callTimeoutMs: 30_000, retryCount: 0 });
  const provider = new ClassicProvider({ client, source: 'live', scope, cache: new ClassicSnapshotCache(join(home, 'classic-snapshot.json')), userDataDir: classicUserDataDir(scope) });
  const win = await start(provider);
  const sidecarPid = client.connection?.transport?.pid;
  try {
    assert.equal(await evaluate(win, `document.getElementById('connection')?.textContent`), '需要登录');
    await click(win, '#login');
    await waitFor(() => evaluate(win, `document.getElementById('notice')?.textContent.includes('浏览器已打开')`), 'live visible browser begin');
    assert.equal(await evaluate(win, `document.getElementById('login')?.textContent`), '我已登录，检查连接');
    const browserBeforeRefresh = await waitFor(() => {
      const windows = visibleDescendantWindows(sidecarPid);
      return windows.length ? windows : false;
    }, 'visible isolated Chromium window');
    const browserOpenScreenshot = await saveScreenshot(win, 'cuhksz-login-live-browser-open.png');

    await click(win, '#refresh');
    await waitFor(() => evaluate(win, `document.getElementById('refresh')?.disabled === false && !document.querySelector('#updated .spinner')`), 'refresh while browser is open');
    assert.equal(await evaluate(win, `document.getElementById('login')?.textContent`), '我已登录，检查连接');
    const browserAfterRefresh = await waitFor(() => {
      const windows = visibleDescendantWindows(sidecarPid);
      return windows.length ? windows : false;
    }, 'visible Chromium after refresh');
    assert.ok(browserBeforeRefresh.some(before => browserAfterRefresh.some(after => Number(after.id) === Number(before.id))), 'refresh replaced the visible login browser');
    const refreshScreenshot = await saveScreenshot(win, 'cuhksz-login-live-after-refresh.png');
    closeIsolatedBrowserWindow(browserBeforeRefresh[0]);
    await waitFor(() => visibleDescendantWindows(sidecarPid).length === 0, 'closed isolated Chromium window');
    await click(win, '#reopen-login');
    await waitFor(() => evaluate(win, `document.getElementById('notice')?.textContent.includes('浏览器已打开')`), 'reopen after Chromium close');
    const browserAfterReopen = await waitFor(() => {
      const windows = visibleDescendantWindows(sidecarPid);
      return windows.length ? windows : false;
    }, 'new visible Chromium after reopen');
    assert.ok(browserAfterReopen.every(after => !browserBeforeRefresh.some(before => Number(after.id) === Number(before.id))), 'reopen reused a closed browser process');
    const reopenScreenshot = await saveScreenshot(win, 'cuhksz-login-live-reopen-browser.png');
    const checked = await evaluate(win, `window.cuhk.login('complete')`);
    assert.equal(checked?.state, 'auth-required');
    assert.equal(checked?.error?.code, 'AUTH_REQUIRED');
    await close(win, provider, sidecarPid);
    return { mode: 'live', stateAfterBegin: 'auth-required', visibleBrowser: browserBeforeRefresh, browserAfterRefresh, browserAfterReopen, refreshKeptSameBrowserPid: true, completeWithoutCredentials: checked, sidecarPid, browserExitedOnClose: true, sidecarExited: true, screenshots: [browserOpenScreenshot, refreshScreenshot, reopenScreenshot] };
  } catch (error) {
    await close(win, provider, sidecarPid);
    throw error;
  }
}

async function main() {
  if (!process.versions.electron) throw new Error('This harness must run under Electron');
  return mode === 'live' ? runLive() : runMock();
}

main().then(result => { console.log(JSON.stringify(result)); app.exit(0); }).catch(error => { console.error(error?.stack || String(error)); app.exit(1); });
