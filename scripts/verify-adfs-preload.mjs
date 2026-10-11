// Offline regression for the observed ADFS span/form.submit flow. Synthetic only.
import { app, BrowserWindow, ipcMain, session } from 'electron';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { LoginAttempt } from '../dist/src/auth/preferences.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const isolated = session.fromPartition('lms-adfs-fixture', { cache: false });
  const credential = { form: { page: 'https://adfs.example.invalid/adfs/ls/', action: 'https://adfs.example.invalid/adfs/ls/', usernameField: 'UserName', passwordField: 'Password' }, username: 'synthetic-netid', password: 'synthetic-not-real' };
  let variant = 'adfs';
  isolated.protocol.handle('https', () => new Response(
    '<!doctype html><html><body><form id="loginForm" method="post" action="' + (variant === 'external' ? 'https://other.example.invalid/session' : '/adfs/ls/') + '">' +
    '<input id="userNameInput" name="UserName" type="email" autocomplete="off">' +
    '<input id="passwordInput" name="Password" type="password" autocomplete="off">' +
    (variant === 'mfa' ? '<input name="otp" autocomplete="one-time-code">' : '') +
    '<input type="hidden" name="AuthMethod" value="FormsAuthentication">' +
    '<span id="submitButton" role="button" tabindex="0" onclick="return Login.submitLoginRequest()" onkeypress="if(event.keyCode===32)Login.submitLoginRequest()">Sign in</span></form>' +
    '<script>window.submits=0;const f=document.forms.loginForm;f.submit=()=>{window.submits++};window.Login={submitLoginRequest(){f.elements.UserName.value="school/"+f.elements.UserName.value;f.submit();return false}};f.addEventListener("keydown",e=>{if(e.key==="Enter"&&e.target.tagName==="INPUT"){e.preventDefault();Login.submitLoginRequest()}});</script></body></html>',
    { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  let attempt, progress = [], requests = 0, submitRequests = 0;
  const win = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, preload: fileURLToPath(new URL('../dist/src/auth/login-preload.cjs', import.meta.url)) } });
  ipcMain.handle('lms:login-fill', (event, form) => { requests++; return attempt.fill(event.senderFrame.url, form); });
  ipcMain.handle('lms:login-submit', (event, form) => { submitRequests++; return attempt.canSubmit(event.senderFrame.url, form); });
  ipcMain.on('lms:login-capture', (event, input) => attempt.capture(event.senderFrame.url, input));
  ipcMain.on('lms:login-progress', (_event, _form, phase) => progress.push(phase));
  const run = (code, userGesture = false) => win.webContents.executeJavaScript(code, userGesture);
  const state = () => run('({user:document.getElementById("userNameInput").value,password:document.getElementById("passwordInput").value,submits:window.submits})');
  async function until(check, label) {
    for (let i = 0; i < 180; i++) { if (await check()) return; await delay(25); }
    throw new Error('Timed out: ' + label);
  }
  async function load({ mode = 'adfs', saved = true, auto = false, url = credential.form.page } = {}) {
    variant = mode; progress = []; requests = 0; submitRequests = 0;
    attempt = new LoginAttempt({ version: 1, rememberPassword: true, autoLogin: auto, ...(saved ? { credential } : {}) });
    await win.loadURL(url); await delay(150);
  }
  async function populate() {
    await run('document.getElementById("userNameInput").value="synthetic-netid";document.getElementById("passwordInput").value="synthetic-not-real"');
  }
  async function trustedClick() {
    const rect = await run('(()=>{const r=document.getElementById("submitButton").getBoundingClientRect();return {x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)}})()');
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...rect });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...rect });
    await delay(100);
  }
  await load();
  assert.deepEqual(await state(), { user: credential.username, password: credential.password, submits: 0 });
  assert(progress.includes('filled'));
  await load({ auto: true });
  assert.equal((await state()).submits, 0, 'A grace period is available before submission');
  await until(async () => (await state()).submits === 1, 'automatic ADFS click');
  assert.equal((await state()).user, 'school/' + credential.username, 'The school handler runs rather than bypassing it');
  assert.equal(attempt.candidate, undefined, 'An automatic script click never recaptures a password');
  assert.equal(submitRequests, 1);
  win.reload(); await delay(300); assert.equal((await state()).submits, 0, 'No automatic retry loop');
  await load({ saved: false }); await populate();
  await run('document.getElementById("submitButton").click()', true); await delay(100);
  assert.equal(attempt.candidate, undefined, 'Even a script click with activation is not a trusted click');
  await populate(); await trustedClick();
  await until(() => !!attempt.candidate, 'trusted ADFS click capture');
  assert.deepEqual(attempt.candidate, credential, 'Capture happens before the school normalizes the NetID');
  await load({ saved: false }); await populate();
  await run('document.getElementById("passwordInput").focus()');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await until(() => !!attempt.candidate, 'trusted Enter capture');
  assert.deepEqual(attempt.candidate, credential);
  for (const mode of ['external', 'mfa']) {
    await load({ mode, auto: true }); assert.equal((await state()).password, ''); assert.equal(requests, mode === 'external' ? 1 : 0);
    await populate(); await trustedClick();
    if (mode === 'external') assert.equal(attempt.candidate?.form.action, 'https://other.example.invalid/session');
    else assert.equal(attempt.candidate, undefined);
  }
  await load({ saved: false, url: 'https://adfs.example.invalid/course' });
  await populate(); await trustedClick(); assert.equal(attempt.candidate?.form.page, 'https://adfs.example.invalid/course', 'Standard login forms are supported beyond the reviewed ADFS path');
  await load({ auto: true });
  attempt.stopAutomation(); win.webContents.send('lms:stop-automation');
  await delay(2200); assert.equal((await state()).submits, 0); assert.equal(submitRequests, 0);
  await load({ auto: true });
  await run('document.getElementById("passwordInput").focus()');
  win.webContents.sendInputEvent({ type: 'char', keyCode: 'x' });
  await delay(2200); assert.equal((await state()).submits, 0); assert(progress.includes('manual'));
  await load({ auto: true });
  await run('document.getElementById("userNameInput").value="changed-by-page"');
  await delay(2200); assert.equal((await state()).submits, 0); assert(progress.includes('manual'));
  await isolated.clearStorageData(); win.destroy();
  console.log('ADFS preload passed: trusted click/Enter capture, school-script auto-login, fill-only, grace cancellation, user takeover, changed fields, one-shot behavior and MFA/origin guards. Synthetic data only.');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
