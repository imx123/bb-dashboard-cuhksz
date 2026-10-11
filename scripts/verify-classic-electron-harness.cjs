const { app, BrowserWindow, shell } = require('electron');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = resolve(__dirname, '..');
const phase = process.env.E2E_PHASE || 'first';
const home = resolve(process.env.LMS_HOME || join(root, '.work', 'electron-ui-e2e-home'));
const screenshots = join(root, '.work', 'electron-ui-e2e-screenshots');
const reportPath = join(root, '.work', 'electron-ui-e2e.json');
const origin = 'https://bb.cuhk.edu.cn';
const opened = [];

// Exercise the real URL IPC without opening a browser window from this hidden harness.
shell.openExternal = async value => { opened.push(String(value)); };

async function waitFor(check, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

const evaluate = (win, source) => win.webContents.executeJavaScript(source, true);

async function click(win, selector) {
  const clicked = await evaluate(win, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true; })()`);
  assert.equal(clicked, true, `missing clickable UI node: ${selector}`);
}

async function waitForIdle(win) {
  await waitFor(async () => evaluate(win, `document.getElementById('refresh')?.disabled === false && !document.querySelector('#updated .spinner') && document.getElementById('connection')?.textContent === '离线演示'`), 'offline fixture refresh');
}

async function saveScreenshot(win, name) {
  const path = join(screenshots, name);
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

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !['ESRCH', 'EINVAL'].includes(error?.code);
  }
}

function scopeKey(scope) {
  return createHash('sha256').update(scope).digest('hex');
}

async function startDashboard() {
  const [{ startDashboard }, { ClassicMcpClient }, { ClassicProvider }, { ClassicSnapshotCache }, { completionKey, completionScope }] = await Promise.all([
    import(pathToFileURL(join(root, 'dist', 'src', 'dashboard', 'app.js')).href),
    import(pathToFileURL(join(root, 'dist', 'src', 'classic', 'mcp-client.js')).href),
    import(pathToFileURL(join(root, 'dist', 'src', 'classic', 'provider.js')).href),
    import(pathToFileURL(join(root, 'dist', 'src', 'classic', 'cache.js')).href),
    import(pathToFileURL(join(root, 'dist', 'src', 'dashboard', 'completion-store.js')).href),
  ]);
  const client = new ClassicMcpClient({
    mode: 'offline-fixture',
    fixturePath: join(root, 'test', 'fixtures', 'classic'),
    connectTimeoutMs: 5_000,
    callTimeoutMs: 10_000,
  });
  const cache = new ClassicSnapshotCache(join(home, 'classic-snapshots.json'));
  const provider = new ClassicProvider({ client, cache, scope: 'cuhksz|https://bb.cuhk.edu.cn|offline-fixture', source: 'offline-fixture' });
  let allowQuit = false;
  const preventQuit = event => { if (!allowQuit) event.preventDefault(); };
  app.on('before-quit', preventQuit);
  await startDashboard({ provider });
  const win = BrowserWindow.getAllWindows().find(item => !item.isDestroyed());
  assert.ok(win, 'dashboard BrowserWindow was not created');
  win.hide();
  await waitForIdle(win);
  assert.equal(await evaluate(win, `document.getElementById('login').textContent`), '登录 / 重新授权');
  assert.equal(await evaluate(win, `document.getElementById('coverage').textContent`), '离线演示：模拟课程数据，尚未连接学校账号。');
  const sidecarPid = client.connection?.transport?.pid;
  assert.ok(sidecarPid, 'fixture Sidecar process did not stay alive after load');
  return { client, provider, win, sidecarPid, completionKey, completionScope, preventQuit, setAllowQuit: () => { allowQuit = true; } };
}

async function closeDashboard(session) {
  let closed = false;
  session.win.once('closed', () => { closed = true; });
  session.win.close();
  await waitFor(() => closed, 'dashboard window close', 10_000);
  await waitFor(() => !processAlive(session.sidecarPid), `Sidecar ${session.sidecarPid} exit`, 10_000);
  assert.equal(processAlive(session.sidecarPid), false, 'Sidecar process remained after window close');
  session.setAllowQuit();
  app.removeListener('before-quit', session.preventQuit);
  return { sidecarPid: session.sidecarPid, sidecarExited: true };
}

async function runFirst(session) {
  const { win, provider } = session;
  const sourceUrls = [
    ...provider.snapshot.courses,
    ...provider.snapshot.announcements,
    ...provider.snapshot.assignments,
    ...provider.snapshot.files,
  ].map(item => item.url).filter(Boolean);
  assert.ok(sourceUrls.length > 0);
  assert.ok(sourceUrls.every(url => url.startsWith(origin + '/')), 'fixture source URL escaped the Classic origin');

  await click(win, '[data-page="courses"]');
  const courses = await evaluate(win, `document.querySelectorAll('.course-card').length`);
  assert.equal(courses, 3);
  const coursesScreenshot = await saveScreenshot(win, 'courses.png');
  const openedBeforeCourse = opened.length;
  await click(win, '.course-card button');
  await waitFor(() => opened.length === openedBeforeCourse + 1, 'course source open');

  await click(win, '[data-page="announcements"]');
  const announcements = await evaluate(win, `document.querySelectorAll('.announcement').length`);
  assert.ok(announcements > 0);
  const announcementsScreenshot = await saveScreenshot(win, 'announcements.png');

  await click(win, '[data-page="files"]');
  const files = await evaluate(win, `document.querySelectorAll('.file').length`);
  assert.ok(files > 0);
  const filesScreenshot = await saveScreenshot(win, 'files.png');
  const openedBeforeFile = opened.length;
  await click(win, '.file button');
  await waitFor(() => opened.length === openedBeforeFile + 1, 'file source open');

  await click(win, '[data-page="tasks"]');
  const filterCounts = {};
  const filterScreenshots = {};
  for (const days of [7, 14, 30]) {
    await evaluate(win, `(() => { const select = document.getElementById('days'); select.value = ${JSON.stringify(String(days))}; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitForIdle(win);
    filterCounts[days] = await evaluate(win, `document.querySelectorAll('.task').length`);
    assert.equal(await evaluate(win, `document.body.textContent.includes('日期待确认')`), true, `no-date assignment group missing for ${days} days`);
    filterScreenshots[days] = await saveScreenshot(win, `tasks-${days}.png`);
  }
  assert.ok(filterCounts[7] >= 1, JSON.stringify(filterCounts));
  assert.ok(filterCounts[14] > filterCounts[7], JSON.stringify(filterCounts));
  assert.ok(filterCounts[30] >= filterCounts[14], JSON.stringify(filterCounts));

  const beforeRefresh = filterCounts[30];
  await click(win, '#refresh');
  await waitForIdle(win);
  const afterRefresh = await evaluate(win, `document.querySelectorAll('.task').length`);
  assert.equal(afterRefresh, beforeRefresh, 'refresh changed fixture task count');

  const duplicateAssignments = provider.snapshot.assignments.filter(item => item.title === '重复标题作业');
  assert.equal(duplicateAssignments.length, 2, 'fixture must contain two same-title assignments');
  const selectedDuplicate = duplicateAssignments[1];
  const openedBeforeAssignment = opened.length;
  await evaluate(win, `(() => { const rows = [...document.querySelectorAll('.task')].filter(row => row.querySelector('.task-name')?.textContent === '重复标题作业'); const row = rows.at(-1); if (!row) return false; row.querySelector('.task-name')?.click(); return true; })()`);
  await waitFor(() => opened.length === openedBeforeAssignment + 1, 'assignment source open');
  const checkboxLabel = await evaluate(win, `(() => { const rows = [...document.querySelectorAll('.task')].filter(row => row.querySelector('.task-name')?.textContent === '重复标题作业'); return rows.at(-1)?.querySelector('input[type="checkbox"]')?.getAttribute('aria-label') || ''; })()`);
  assert.ok(checkboxLabel.startsWith('完成 '), 'manual completion checkbox missing');
  const completedTitle = checkboxLabel.slice(3);
  const completedId = selectedDuplicate.id;
  await evaluate(win, `(() => { const rows = [...document.querySelectorAll('.task')].filter(row => row.querySelector('.task-name')?.textContent === '重复标题作业'); rows.at(-1)?.querySelector('input[type="checkbox"]')?.click(); return true; })()`);
  await waitFor(() => evaluate(win, `(() => { const rows = [...document.querySelectorAll('.task')].filter(row => row.querySelector('.task-name')?.textContent === '重复标题作业'); return rows.at(-1)?.querySelector('input[type="checkbox"]')?.checked === true; })()`), 'manual completion save');
  assert.equal(await evaluate(win, `document.body.textContent.includes('已完成 · 手动')`), true);
  const duplicateMarks = await evaluate(win, ` [...document.querySelectorAll('.task')].filter(row => row.querySelector('.task-name')?.textContent === '重复标题作业').map(row => row.querySelector('input[type="checkbox"]')?.checked === true) `);
  assert.deepEqual(duplicateMarks, [false, true], 'same-title assignments shared a completion mark');
  await click(win, '#refresh');
  await waitForIdle(win);
  assert.ok(await evaluate(win, `document.querySelectorAll('input[type="checkbox"]:checked').length >= 1`), 'manual completion did not survive refresh');
  assert.deepEqual(await evaluate(win, ` [...document.querySelectorAll('.task')].filter(row => row.querySelector('.task-name')?.textContent === '重复标题作业').map(row => row.querySelector('input[type="checkbox"]')?.checked === true) `), [false, true]);

  const rejected = [];
  for (const value of ['https://evil.example/assignment', 'http://bb.cuhk.edu.cn/course', 'https://bb.cuhk.edu.cn.evil.example/file']) {
    const result = await evaluate(win, `window.cuhk.open(${JSON.stringify(value)})`);
    assert.equal(result?.error?.code, 'URL_REJECTED', `unsafe source URL was accepted: ${value}`);
    rejected.push({ value, code: result.error.code });
  }

  const completionMarks = JSON.parse(await readFile(join(home, 'dashboard-completion.json'), 'utf8'));
  const completedItem = provider.snapshot.assignments.find(item => item.id === completedId);
  assert.ok(completedItem, `completed assignment not found in provider snapshot: ${completedTitle}`);
  const offlineScope = session.completionScope('cuhksz', `${origin}|offline-fixture`, 'offline-fixture');
  const liveScope = session.completionScope('cuhksz', `${origin}|local-account`, 'local-account');
  const otherProfileScope = session.completionScope('other-profile', `${origin}|offline-fixture`, 'offline-fixture');
  const completedKey = session.completionKey(completedItem);
  assert.equal(completionMarks[offlineScope]?.[completedKey], true);
  assert.equal(completionMarks[liveScope]?.[completedKey], undefined);
  assert.equal(completionMarks[otherProfileScope]?.[completedKey], undefined);
  const cache = JSON.parse(await readFile(join(home, 'classic-snapshots.json'), 'utf8'));
  assert.ok(cache[scopeKey('cuhksz|https://bb.cuhk.edu.cn|offline-fixture')]);
  assert.equal(cache[scopeKey('cuhksz|https://bb.cuhk.edu.cn|live')], undefined);
  assert.equal(cache[scopeKey('other-profile|https://bb.cuhk.edu.cn|offline-fixture')], undefined);

  const closed = await closeDashboard(session);
  return {
    phase,
    courses,
    announcements,
    files,
    assignments: provider.snapshot.assignments.length,
    filterCounts,
    completedTitle,
    completedId,
    duplicateMarks,
    sourceUrls: sourceUrls.length,
    opened,
    rejected,
    isolation: { profileAndModeSeparated: true, cacheAndCompletionSeparated: true },
    screenshots: { courses: coursesScreenshot, announcements: announcementsScreenshot, files: filesScreenshot, tasks: filterScreenshots },
    ...closed,
  };
}

async function runRestart(session) {
  const { win, provider } = session;
  await click(win, '[data-page="tasks"]');
  await evaluate(win, `(() => { const select = document.getElementById('days'); select.value = '30'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitForIdle(win);
  const checked = await evaluate(win, `document.querySelectorAll('input[type="checkbox"]:checked').length`);
  assert.ok(checked >= 1, 'manual completion did not survive a fresh Electron process');
  const duplicateMarks = await evaluate(win, ` [...document.querySelectorAll('.task')].filter(row => row.querySelector('.task-name')?.textContent === '重复标题作业').map(row => row.querySelector('input[type="checkbox"]')?.checked === true) `);
  assert.deepEqual(duplicateMarks, [false, true], 'same-title completion mark changed after restart');
  const tasksScreenshot = await saveScreenshot(win, 'tasks-restart.png');
  const closed = await closeDashboard(session);
  return { phase, assignments: provider.snapshot.assignments.length, checked, duplicateMarks, screenshots: { tasks: tasksScreenshot }, ...closed };
}

async function run() {
  if (!process.versions.electron) throw new Error('ELECTRON_RUN_AS_NODE kept this child in normal Node mode');
  await mkdir(screenshots, { recursive: true });
  const session = await startDashboard();
  try {
    return phase === 'restart' ? await runRestart(session) : await runFirst(session);
  } catch (error) {
    try { await session.provider.close(); } catch { /* best effort cleanup for the harness */ }
    if (!session.win.isDestroyed()) session.win.destroy();
    throw error;
  }
}

app.whenReady().then(run).then(async result => {
  await writeFile(reportPath, JSON.stringify({ ...(await readExisting()), [phase]: result }, null, 2));
  console.log(JSON.stringify(result));
  app.exit(0);
}).catch(error => {
  console.error(error?.stack || String(error));
  app.exit(1);
});

async function readExisting() {
  try { return JSON.parse(await readFile(reportPath, 'utf8')); }
  catch { return {}; }
}
