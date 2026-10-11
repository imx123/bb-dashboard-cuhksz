// Offline Chromium smoke test; never opens a school URL or reads real configuration.
// Run after build: npx electron scripts/verify-auth-ui.mjs
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { authorizationHTML } from '../dist/src/auth/ui.js';

app.whenReady().then(async () => {
  const state = { active: 'example', profiles: [
    { id: 'example', label: '示例大学 · 主账号', timezone: 'Asia/Hong_Kong', canvas: 'https://canvas.example.edu' },
    { id: 'exchange', label: '交换学校 · 研究账号', timezone: 'Europe/London', canvas: 'https://exchange.example.edu', blackboard: 'https://learn.example.edu' },
  ], preferences: {} };
  const win = new BrowserWindow({ show: false, width: 480, height: 460, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true } });
  const html = authorizationHTML().replace(/(<script nonce="[^"]+">)/, `$1let fixture=${JSON.stringify(state)};window.lms={state:async()=>fixture,onState:fn=>{window.pushState=fn},setLoginOptions:async(id,platform,options)=>{fixture.preferences[id]??={};fixture.preferences[id][platform]={...options,hasPassword:false};return fixture},login:async(...args)=>{window.loginArgs=args;fixture={...fixture,busy:true};window.pushState(fixture)},cancelLogin:async()=>{fixture={...fixture,busy:false,message:'已取消本次登录。'};return fixture},stopAutoLogin:async()=>{for(const settings of Object.values(fixture.preferences))for(const pref of Object.values(settings))pref.autoLogin=false;fixture.message='自动登录已关闭，可在学校窗口继续手动登录。';return fixture}};`);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const inspect = () => win.webContents.executeJavaScript(`({title:document.title,school:document.getElementById('school').value,platforms:Array.from(document.getElementById('platform').options,o=>o.value),disabled:document.getElementById('school').disabled,loginDisabled:document.getElementById('login').disabled,overflow:document.documentElement.scrollHeight>innerHeight})`);
  let actual = await inspect();
  assert.equal(actual.title, 'lms-cli'); assert.equal(actual.school, 'example'); assert.deepEqual(actual.platforms, ['canvas']);
  assert.equal(await win.webContents.executeJavaScript(`document.getElementById('remember').checked||document.getElementById('auto').checked`), false);
  await win.webContents.executeJavaScript(`document.getElementById('auto').click()`);
  assert.equal(await win.webContents.executeJavaScript(`document.getElementById('remember').checked&&document.getElementById('auto').checked`), true);
  await win.webContents.executeJavaScript(`document.getElementById('remember').click()`);
  assert.equal(await win.webContents.executeJavaScript(`document.getElementById('remember').checked||document.getElementById('auto').checked`), false);
  await win.webContents.executeJavaScript(`document.getElementById('school').value='exchange';document.getElementById('school').dispatchEvent(new Event('change'));`);
  actual = await inspect(); assert.equal(actual.school, 'exchange'); assert.deepEqual(actual.platforms, ['all', 'canvas', 'blackboard']); assert.equal(actual.overflow, false);
  await win.webContents.executeJavaScript(`document.getElementById('platform').value='blackboard';document.getElementById('platform').dispatchEvent(new Event('change'));document.getElementById('auto').click();`);
  await win.webContents.executeJavaScript(`document.getElementById('login').click();`);
  assert.deepEqual(await win.webContents.executeJavaScript('window.loginArgs'), ['exchange', 'blackboard']);
  assert.equal((await inspect()).disabled, true);
  assert.equal(await win.webContents.executeJavaScript(`!document.getElementById('cancel-login').hidden&&document.getElementById('selection').hidden&&!document.getElementById('auto').disabled`), true);
  if (process.env.LMS_UI_SCREENSHOT) await writeFile(process.env.LMS_UI_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.getElementById('auto').click()`);
  assert.equal(await win.webContents.executeJavaScript(`document.getElementById('remember').checked&&!document.getElementById('auto').checked&&!document.getElementById('cancel-login').hidden`), true);
  await win.webContents.executeJavaScript(`document.getElementById('cancel-login').click()`);
  assert.equal((await inspect()).disabled, false);
  assert.equal(await win.webContents.executeJavaScript(`document.getElementById('cancel-login').hidden&&document.getElementById('status').textContent==='已取消本次登录。'`), true);
  const hostile = { ...state, lockedProfile: 'example', profiles: [{ ...state.profiles[0], label: '</script><img src=x onerror="window.injected=true">' }] };
  await win.webContents.executeJavaScript(`window.pushState(${JSON.stringify(hostile)})`);
  actual = await inspect(); assert.equal(actual.school, 'example'); assert.equal(actual.disabled, true);
  assert.equal(await win.webContents.executeJavaScript('document.images.length'), 0);
  await win.webContents.executeJavaScript('window.pushState({profiles:[]})'); assert.equal((await inspect()).loginDisabled, true);
  console.log('Electron authorization UI smoke test passed: opt-in settings, stop automatic login, cancel login, profile isolation (synthetic schools, no network).');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
