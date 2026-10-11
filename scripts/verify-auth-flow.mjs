// Real --from-cli entry/IPC, synthetic HTTPS, in-memory vault and stub validator.
// Never connects to a real school or accesses the OS credential store.
import { app, BrowserWindow, ipcMain, session } from 'electron';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

const home = mkdtempSync(join(tmpdir(), 'lms-real-flow-'));
process.env.LMS_HOME = home;
app.setPath('userData', join(home, 'chromium'));
const root = process.env.LMS_AUTH_TEST_APP ? resolve(process.env.LMS_AUTH_TEST_APP) : fileURLToPath(new URL('../', import.meta.url));
const moduleURL = name => pathToFileURL(join(root, 'dist/src', name + '.js')).href;
const profile = { id: 'fixture', label: '示例大学', timezone: 'UTC', blackboard: 'https://learn.example.invalid' };
const html = '<!doctype html><html><head><title>学校登录 · 离线测试</title><style>body{font:16px -apple-system,sans-serif;background:#fff;color:#111;padding:70px 32px;margin:0}main{max-width:320px;margin:auto}h1{font-size:24px}label{display:block;margin:20px 0 8px}input,button{font:inherit;box-sizing:border-box;width:100%;padding:12px}button{margin-top:24px;background:#111;color:white;border:0}p{font-size:12px;color:#555}</style></head><body><main><h1>学校账号登录</h1><p>离线测试页面，不连接真实学校</p><form method="post" action="/session"><label for="user">账号</label><input id="user" name="username" autocomplete="username"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password"><button type="submit">登录</button></form></main><script>window.submits=0;document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.submits++});</script></body></html>';
app.on('session-created', session => {
  session.protocol.handle('https', () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 160; i++) { if (await check()) return; await delay(25); }
  throw new Error('Timed out: ' + label);
}
const originalExit = app.exit.bind(app);
app.whenReady().then(async () => {
  const { addProfile } = await import(moduleURL('config'));
  const { vault } = await import(moduleURL('vault'));
  const memory = new Map(); let generation = 0;
  const key = (p, slot) => p.id + ':' + slot;
  vault.read = async (p, slot) => structuredClone(memory.get(key(p, slot)) ?? null);
  vault.write = async (p, slot, value, expected) => {
    const previous = memory.get(key(p, slot));
    if (expected !== undefined && previous?.generation !== expected) return null;
    const next = expected ?? String(++generation);
    memory.set(key(p, slot), { generation: next, value: structuredClone(value) }); return next;
  };
  vault.update = async (p, slot, change) => { const value = change((await vault.read(p, slot))?.value ?? null); await vault.write(p, slot, value); return value; };
  vault.remove = async (p, slot) => { memory.delete(key(p, slot)); };
  await addProfile(profile);
  const hook = registerHooks({ load(url, context, next) {
    if (url === moduleURL('auth/validate')) return { format: 'module', shortCircuit: true, source: 'import { vault } from ' + JSON.stringify(moduleURL('vault')) + '; export async function validateInWorker(p,platform,candidate,signal){signal.throwIfAborted();const validatedAt=new Date().toISOString();await vault.write(p,platform,{...candidate,validatedAt});return {ok:true,platform,validatedAt};}' };
    return next(url, context);
  } });
  const exits = []; app.exit = code => { exits.push(code); };
  let captures = 0; ipcMain.on('lms:login-capture', () => { captures++; });
  process.argv.push('--from-cli', '--profile', 'fixture', '--platform', 'blackboard');
  await import(moduleURL('auth/app'));
  await until(() => BrowserWindow.getAllWindows().some(w => w.contentView.children.some(v => v.webContents && v.webContents !== w.webContents)), 'direct school view');
  const window = BrowserWindow.getAllWindows()[0];
  const school = () => window.contentView.children.find(view => view.webContents && view.webContents !== window.webContents);
  await until(() => school()?.webContents.getURL() === profile.blackboard + '/', 'school navigation');
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'No extra settings window');
  const ui = code => window.webContents.executeJavaScript(code);
  const remote = code => school().webContents.executeJavaScript(code);
  await until(async () => await ui("document.body.hasAttribute('data-busy')"), 'compact toolbar');
  assert.equal(await ui("document.getElementById('selection').hidden"), true);
  assert.equal(await ui("document.getElementById('remember').disabled"), false);
  assert.equal(await remote('typeof window.lms'), 'undefined');
  assert.equal(await remote('typeof window.require'), 'undefined');
  assert.equal(school().getBounds().y, 120);
  window.setContentSize(480, 640); await delay(100);
  assert.equal(school().getBounds().width, 480); assert.equal(school().getBounds().height, 520);
  assert.equal(await ui('document.documentElement.scrollWidth > innerWidth'), false);
  window.setContentSize(900, 720); await delay(100);
  if (process.env.LMS_UI_SCREENSHOT) await writeFile(process.env.LMS_UI_SCREENSHOT, (await window.capturePage()).toPNG());
  if (process.env.LMS_UI_REVIEW === '1') { console.log('QA_WINDOW_READY: synthetic school window'); await delay(30000); }
  await ui("document.getElementById('remember').click()");
  await until(() => memory.get('fixture:login:blackboard')?.value.rememberPassword, 'consent saved while school is open');
  await school().webContents.executeJavaScript("document.querySelector('[name=username]').value='synthetic-student';document.querySelector('[name=password]').value='synthetic-not-real'");
  const submitBounds = await remote("(()=>{const r=document.querySelector('button[type=submit]').getBoundingClientRect();return {x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)}})()");
  school().webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...submitBounds });
  school().webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...submitBounds });
  await until(() => captures > 0, 'user gesture captured');
  await school().webContents.session.cookies.set({ url: profile.blackboard, name: 'JSESSIONID', value: 'synthetic-session', secure: true });
  await until(() => exits.includes(0), 'successful verified login');
  const remembered = memory.get('fixture:login:blackboard')?.value;
  assert.equal(remembered.credential.username, 'synthetic-student');
  assert.equal(remembered.autoLogin, false); assert.equal(school(), undefined);
  const persistedCookies = await session.fromPartition('persist:lms-login-fixture-blackboard').cookies.get({ url: profile.blackboard });
  assert.equal(persistedCookies.some(cookie => cookie.name === 'JSESSIONID' && cookie.value === 'synthetic-session'), true, 'remember-password keeps the app session partition');
  await ui("window.lms.login('fixture','blackboard')");
  await until(async () => school() && (await remote("document.querySelector('[name=password]')?.value")) === 'synthetic-not-real', 'remember-only fill');
  assert.equal(await remote('window.submits'), 0, 'Remember-only never submits');
  let prevented = false; const previousExits = exits.length;
  school().webContents.emit('before-input-event', { preventDefault() { prevented = true; } }, { type: 'keyDown', key: 'Escape' });
  await until(() => exits.length > previousExits, 'Escape cancellation');
  assert(prevented); assert.equal(exits.at(-1), 2); assert.equal(school(), undefined);
  await session.fromPartition('persist:lms-login-fixture-blackboard').clearStorageData();
  await ui("document.getElementById('auto').click()");
  await until(() => memory.get('fixture:login:blackboard')?.value.autoLogin, 'auto-login opt-in');
  await ui("window.lms.login('fixture','blackboard')");
  await until(async () => school() && (await remote('window.submits')) === 1, 'single automatic submission');
  await ui("document.getElementById('auto').click()");
  await until(() => memory.get('fixture:login:blackboard')?.value.autoLogin === false, 'disable automatic login during login');
  assert.equal(memory.get('fixture:login:blackboard').value.rememberPassword, true);
  assert.equal(await remote('window.submits'), 1);
  await school().webContents.executeJavaScript("window.open('/popup');void 0", true);
  await until(() => BrowserWindow.getAllWindows().length === 2, 'SSO popup');
  const lastExits = exits.length;
  await ui("document.getElementById('cancel-login').click()");
  await until(() => exits.length > lastExits, 'cancel button');
  assert.equal(exits.at(-1), 2); assert.equal(school(), undefined); assert.equal(BrowserWindow.getAllWindows().length, 1);
  await ui("document.getElementById('remember').click()");
  await until(() => !memory.has('fixture:login:blackboard'), 'forget saved password');
  hook.deregister();
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  console.log('Real authorization entry passed: first-run single window, live opt-in, save-after-validation, remembered fill, one-shot auto-login, Escape/cancel, popup cleanup, opt-out, resizing and renderer isolation. Synthetic data only.');
  originalExit(0);
}).catch(async error => { console.error(error); for (const win of BrowserWindow.getAllWindows()) win.destroy(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); originalExit(1); });
