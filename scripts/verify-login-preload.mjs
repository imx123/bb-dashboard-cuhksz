// Offline Electron integration test. Intercepts every request in an ephemeral
// session; no real school, password store, application data or network is used.
import { app, BrowserWindow, ipcMain, session } from 'electron';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { LoginAttempt } from '../dist/src/auth/preferences.js';
import { parseTotpSecret, TotpRecordSchema } from '../dist/src/auth/totp.js';

app.whenReady().then(async () => {
  const isolated = session.fromPartition('lms-preload-fixture', { cache: false });
  const credential = { form: { page: 'https://login.example.invalid/signin', action: 'https://login.example.invalid/session', usernameField: 'username', passwordField: 'password' }, username: 'synthetic-student', password: 'synthetic-not-a-real-password' };
  let variant = 'normal';
  isolated.protocol.handle('https', () => {
    const action = variant === 'external' ? 'https://other.example.invalid/session' : variant === 'otp' ? '/mfa' : '/session';
    const fields = variant === 'otp'
      ? '<label>Verification<input name="otp" autocomplete="one-time-code"></label>'
      : `<label>Username<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="${variant === 'new-password' ? 'new-password' : 'current-password'}"></label>${variant === 'mfa' ? '<label>Verification<input name="otp" autocomplete="one-time-code"></label>' : ''}`;
    return new Response(`<!doctype html><html><body><form method="post" action="${action}">${fields}<button type="submit">Sign in</button></form><script>window.submits=0;document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();window.submits++});</script></body></html>`, { headers: { 'content-type': 'text/html' } });
  });
  const totp = TotpRecordSchema.parse({ version: 1, ...parseTotpSecret('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ') });
  let attempt = new LoginAttempt(null);
  let requests = 0;
  let submitRequests = 0;
  let pendingFill;
  let pendingSubmit;
  const win = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, preload: fileURLToPath(new URL('../dist/src/auth/login-preload.cjs', import.meta.url)) } });
  ipcMain.handle('lms:login-fill', async (event, form) => {
    assert.equal(event.sender, win.webContents); assert.equal(event.senderFrame, win.webContents.mainFrame); requests++;
    const result = attempt.fill(event.senderFrame.url, form);
    if (pendingFill) await pendingFill;
    return result;
  });
  ipcMain.handle('lms:login-submit', async (event, form) => {
    assert.equal(event.sender, win.webContents); assert.equal(event.senderFrame, win.webContents.mainFrame); submitRequests++;
    const result = attempt.canSubmit(event.senderFrame.url, form);
    if (pendingSubmit) await pendingSubmit;
    return result;
  });
  ipcMain.handle('lms:login-otp-fill', async (event, form) => {
    assert.equal(event.sender, win.webContents); assert.equal(event.senderFrame, win.webContents.mainFrame);
    return attempt.fillOtp(event.senderFrame.url, form);
  });
  ipcMain.handle('lms:login-otp-submit', async (event, form) => {
    assert.equal(event.sender, win.webContents); assert.equal(event.senderFrame, win.webContents.mainFrame);
    return attempt.canSubmitOtp(event.senderFrame.url, form);
  });
  ipcMain.on('lms:login-capture', (event, input) => {
    assert.equal(event.sender, win.webContents); assert.equal(event.senderFrame, win.webContents.mainFrame);
    attempt.capture(event.senderFrame.url, input);
  });
  const state = () => win.webContents.executeJavaScript(`({user:document.querySelector('[name=username]')?.value||'',password:document.querySelector('[name=password]')?.value||'',otp:document.querySelector('[name=otp]')?.value||'',submits:window.submits,bridge:typeof window.lms,node:typeof window.require})`);
  async function load(mode, autoLogin, url = credential.form.page) {
    variant = mode; requests = 0; submitRequests = 0; attempt = new LoginAttempt({ version: 1, rememberPassword: true, autoLogin, credential }, mode === 'otp' ? totp : null);
    await win.loadURL(url);
    // Bound the IPC/DOMContentLoaded completion wait, independent of network.
    for (let i = 0; i < 20; i++) { if (requests) break; await new Promise(resolve => setTimeout(resolve, 25)); }
    await new Promise(resolve => setTimeout(resolve, 100));
    return state();
  }
  let actual = await load('normal', false);
  assert.equal(actual.user, credential.username); assert.equal(actual.password, credential.password); assert.equal(actual.submits, 0);
  assert.equal(actual.bridge, 'undefined'); assert.equal(actual.node, 'undefined');
  await load('normal', true);
  for (let i = 0; i < 140 && !(await state()).submits; i++) await new Promise(resolve => setTimeout(resolve, 25));
  actual = await state(); assert.equal(actual.submits, 1); assert.equal(requests, 1);
  // Navigating back after a failed automatic login cannot resubmit a second time.
  await win.reload(); await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await state()).submits, 0);
  for (const mode of ['mfa', 'new-password', 'external']) {
    actual = await load(mode, true); assert.equal(actual.password, ''); assert.equal(actual.submits, 0);
    // Cross-origin forms can be inspected for a precise saved-form match, but
    // a changed action is rejected by the main-process origin/form guard.
    assert.equal(requests, mode === 'external' ? 1 : 0);
  }
  actual = await load('otp', true, 'https://login.example.invalid/mfa');
  for (let i = 0; i < 140 && !(await state()).submits; i++) await new Promise(resolve => setTimeout(resolve, 25));
  actual = await state(); assert.equal(actual.otp.length, 6); assert.equal(actual.submits, 1);
  actual = await load('normal', true, 'https://login.example.invalid/course');
  assert.equal(actual.password, ''); assert.equal(actual.submits, 0);
  // Revocation must beat a fill response that already contains credentials.
  let releaseFill;
  pendingFill = new Promise(resolve => { releaseFill = resolve; });
  await load('normal', true); assert.equal(requests, 1);
  attempt.stopAutomation(); win.webContents.send('lms:stop-automation');
  await state(); releaseFill(); pendingFill = undefined;
  await new Promise(resolve => setTimeout(resolve, 150));
  actual = await state(); assert.equal(actual.password, ''); assert.equal(actual.submits, 0); assert.equal(submitRequests, 0);
  // A previously granted submit response cannot fire after cancellation.
  let releaseSubmit;
  pendingSubmit = new Promise(resolve => { releaseSubmit = resolve; });
  await load('normal', true);
  for (let i = 0; i < 140 && !submitRequests; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(submitRequests, 1);
  attempt.cancel(); win.webContents.send('lms:stop-automation');
  await state(); releaseSubmit(); pendingSubmit = undefined;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await state()).submits, 0); assert.equal(attempt.record, null);
  // Manual form submission captures a candidate; persistence is independently
  // gated by platform identity validation in the app.
  variant = 'normal'; attempt = new LoginAttempt({ version: 1, rememberPassword: true, autoLogin: false });
  await win.loadURL(credential.form.page);
  await win.webContents.executeJavaScript(`document.querySelector('[name=username]').value='synthetic-student';document.querySelector('[name=password]').value='synthetic-not-a-real-password';document.querySelector('form').requestSubmit()`);
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(attempt.candidate, undefined, 'Page-script requestSubmit is not a user gesture');
  // A real input event marks the trusted gesture; page JavaScript alone cannot.
  const rect = await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('button[type=submit]').getBoundingClientRect();return {x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)}})()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...rect });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...rect });
  for (let i = 0; i < 20 && !attempt.candidate; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(attempt.candidate, credential);
  // A fabricated submit event from the remote page must not capture anything.
  attempt.candidate = undefined;
  await win.webContents.executeJavaScript(`document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(attempt.candidate, undefined);
  await isolated.clearStorageData(); win.destroy();
  console.log('Electron login preload passed: fill-only, one-shot auto-login, pending fill/submit cancellation, capture, origin/form guards, MFA exclusions, sandbox isolation (synthetic data only).');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
