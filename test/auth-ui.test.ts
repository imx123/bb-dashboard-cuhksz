import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { authorizationHTML } from '../src/auth/ui.js';
import { runInNewContext } from 'node:vm';
import type { Profile } from '../src/config.js';

test('authorization page uses the lms-cli brand, school selection and a fresh CSP nonce', () => {
  const html = authorizationHTML();
  const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
  const visible = html.replace(/<style>[\s\S]*?<\/style>|<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
  assert.deepEqual([...new Set(css.match(/#[\da-f]{3,8}\b/gi))].sort(), ['#000', '#fff']);
  assert.match(visible, /lms-cli/);
  assert.match(visible, /开始登录/);
  assert.doesNotMatch(visible, /PolyU|cookie|token/i);
  assert.equal((html.match(/<button\b/g) ?? []).length, 2);
  assert.equal((html.match(/<select\b/g) ?? []).length, 2);
  assert.match(html, /role="status"/);
  assert.match(html, /window\.lms\.login\(school\.value,platform\.value\)/);
  assert.notEqual(html, authorizationHTML(), 'Each page must receive a fresh script nonce');
});

test('plugin, package and marketplace consistently use lms-cli with neutral icons', async () => {
  const manifest = JSON.parse(await readFile(new URL('../plugins/lms-cli/.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  for (const slot of ['composerIcon', 'logo', 'logoDark']) assert.equal(manifest.interface[slot], './assets/lms-icon.png');
  assert.equal(manifest.interface.displayName, 'lms-cli');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const market = JSON.parse(await readFile(new URL('../.agents/plugins/marketplace.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'lms-cli'); assert.equal(pkg.build.productName, 'lms-cli');
  assert.equal(market.name, 'lms-cli'); assert.equal(market.interface.displayName, 'lms-cli');
  assert.equal(manifest.version, pkg.version);
  const png = await readFile(new URL('../plugins/lms-cli/assets/lms-icon.png', import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
});

type State = { profiles: Profile[]; active?: string; lockedProfile?: string; lockedPlatform?: string; currentPlatform?: string; loginUrl?: string; busy?: boolean; message?: string; preferences?: Record<string, Record<string, { rememberPassword: boolean; autoLogin: boolean; hasPassword: boolean }>> };
class Element {
  children: Element[] = []; textContent = ''; disabled = false; hidden = false; checked = false;
  onclick?: () => Promise<void>; onchange?: () => void | Promise<void>; private current = '';
  constructor(private select = false) {}
  get value() { return this.current; }
  set value(value: string) { this.current = !this.select || this.children.some(c => c.value === value) ? value : ''; }
  replaceChildren(...children: Element[]) { this.children = children; if (this.select) this.current = children[0]?.value ?? ''; }
  set innerHTML(_value: string) { throw new Error('Profile data must never be rendered as HTML'); }
}
async function page(initial: State, failLogin = false) {
  const elements = Object.fromEntries(['school', 'platform', 'origins', 'status', 'login', 'setup', 'remember', 'auto', 'password-status', 'cancel-login', 'heading', 'selection'].map(id => [id, new Element(['school', 'platform'].includes(id))])) as Record<string, Element>;
  const calls: string[][] = []; let update!: (state: State) => void;
  const optionCalls: unknown[] = [];
  const actions: string[] = [];
  const html = authorizationHTML();
  runInNewContext(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]!, {
    document: { body: { toggleAttribute: () => {} }, getElementById: (id: string) => elements[id], createElement: () => new Element() },
    window: { lms: { state: async () => initial, onState: (fn: typeof update) => { update = fn; }, login: async (...args: string[]) => { if (failLogin) throw new Error('offline'); calls.push(args); },
      cancelLogin: async () => { actions.push('cancel'); if(failLogin)throw new Error('offline'); initial = { ...initial, busy: false, message: '已取消本次登录。' }; return initial; },
      stopAutoLogin: async () => { actions.push('stop-auto'); if(failLogin)throw new Error('offline'); initial = { ...initial, busy: true, message: '自动登录已关闭，可继续手动登录。', preferences: Object.fromEntries(Object.entries(initial.preferences??{}).map(([id, platforms])=>[id,Object.fromEntries(Object.entries(platforms).map(([platform, settings])=>[platform,{...settings,autoLogin:false}]))])) }; return initial; },
      setLoginOptions: async (id: string, platform: string, options: { rememberPassword: boolean; autoLogin: boolean }) => {
        if (failLogin) throw new Error('keychain locked');
        optionCalls.push(JSON.parse(JSON.stringify([id, platform, options])));
        initial = { ...initial, preferences: { ...initial.preferences, [id]: { ...initial.preferences?.[id], [platform]: { ...options, hasPassword: options.rememberPassword && !!initial.preferences?.[id]?.[platform]?.hasPassword } } } };
        return initial;
      },
    } },
  });
  await Promise.resolve();
  return { elements, calls, optionCalls, update, actions };
}
const a: Profile = { id: 'alpha', label: 'Alpha', timezone: 'Europe/London', canvas: 'https://alpha.instructure.com' };
const b: Profile = { id: 'beta', label: '<img src=x onerror=alert(1)>', timezone: 'America/New_York', blackboard: 'https://learn.beta.edu' };
test('school switching filters platforms and sends the selected profile, not PolyU', async () => {
  const { elements: el, calls } = await page({ profiles: [a, b], active: a.id });
  assert.equal(el.school!.value, 'alpha'); assert.equal(el.platform!.value, 'canvas');
  assert.equal(el.platform!.children.length, 1);
  el.school!.value = 'beta'; el.school!.onchange!();
  assert.equal(el.platform!.value, 'blackboard'); assert.equal(el.platform!.children.length, 1);
  assert.equal(el.school!.children[1]!.textContent, b.label);
  assert.equal(el.origins!.textContent, 'https://learn.beta.edu');
  await el.login!.onclick!(); assert.deepEqual(calls, [['beta', 'blackboard']]);
  assert.equal(el.school!.disabled, true); assert.equal(el.platform!.disabled, true);
});
test('empty state, dual-platform selection and locked authorization jobs', async () => {
  const { elements: el, update } = await page({ profiles: [] });
  assert.equal(el.login!.disabled, true); assert.equal(el.setup!.hidden, false);
  const dual = { ...a, blackboard: 'https://learn.alpha.edu' };
  update({ profiles: [dual, b], active: b.id, lockedProfile: a.id });
  assert.equal(el.school!.value, a.id); assert.equal(el.school!.disabled, true);
  assert.equal(el.platform!.value, 'all'); assert.equal(el.platform!.children.length, 3);
  assert.equal(el.setup!.hidden, true); assert.equal(el.login!.disabled, false);
  update({ profiles: [dual, b], lockedProfile: 'missing' });
  assert.equal(el.login!.disabled, true);
});
test('failed launch allows retry without changing schools', async () => {
  const { elements: el } = await page({ profiles: [b], active: b.id }, true);
  await el.login!.onclick!(); assert.equal(el.login!.disabled, false); assert.equal(el.school!.value, b.id);
});
test('CLI all-platform authorization remains usable for a Blackboard-only school', async () => {
  const { elements: el, calls } = await page({ profiles: [b], lockedProfile: b.id, lockedPlatform: 'all' });
  assert.equal(el.platform!.value, 'blackboard'); assert.equal(el.platform!.disabled, true);
  assert.equal(el.login!.disabled, false); assert.equal(el.remember!.disabled, false);
  await el.login!.onclick!(); assert.deepEqual(calls, [['beta', 'blackboard']]);
});
test('an enabled option never claims a password was saved before successful capture', async () => {
  const initial: State = { profiles: [a], active: a.id, preferences: { alpha: { canvas: { rememberPassword: true, autoLogin: true, hasPassword: false } } } };
  const { elements: el, update } = await page(initial);
  assert.equal(el['password-status']!.textContent, '完成本次学校登录后保存密码');
  update({ ...initial, preferences: { alpha: { canvas: { rememberPassword: true, autoLogin: true, hasPassword: true } } } });
  assert.equal(el['password-status']!.textContent, '下次自动填充并登录');
});
test('remember and automatic login are opt-in, linked, and isolated by school', async () => {
  const { elements: el, optionCalls } = await page({ profiles: [a, b], active: a.id });
  assert.equal(el.remember!.checked, false); assert.equal(el.auto!.checked, false);
  el.auto!.checked = true; await el.auto!.onchange!();
  assert.deepEqual(optionCalls[0], ['alpha', 'canvas', { rememberPassword: true, autoLogin: true }]);
  assert.equal(el.remember!.checked, true); assert.equal(el.auto!.checked, true);
  el.remember!.checked = false; await el.remember!.onchange!();
  assert.deepEqual(optionCalls[1], ['alpha', 'canvas', { rememberPassword: false, autoLogin: false }]);
  el.school!.value = 'beta'; el.school!.onchange!();
  assert.equal(el.remember!.checked, false); assert.equal(el.auto!.checked, false);
});
test('saved preferences restore, locked platform stays selected and failures revert the options', async () => {
  const { elements: el, update } = await page({ profiles: [{ ...a, blackboard: b.blackboard }], lockedProfile: a.id, lockedPlatform: 'blackboard',
    preferences: { alpha: { blackboard: { rememberPassword: true, autoLogin: false, hasPassword: true } } } }, true);
  assert.equal(el.platform!.value, 'blackboard'); assert.equal(el.platform!.disabled, true);
  assert.equal(el.remember!.checked, true); assert.equal(el.auto!.checked, false);
  assert.match(el['password-status']!.textContent, /自动填充/);
  el.remember!.checked = false; await el.remember!.onchange!();
  assert.equal(el.remember!.checked, true); assert.match(el.status!.textContent, /设置未保存/);
  update({ profiles: [a], busy: true }); assert.equal(el.remember!.disabled, false); assert.equal(el.auto!.disabled, false);
});
test('in-progress login can stop automatic submission or cancel without being locked out', async () => {
  const { elements: el, actions, optionCalls } = await page({ profiles:[b],active:b.id,busy:true,preferences:{beta:{blackboard:{rememberPassword:true,autoLogin:true,hasPassword:true}}} });
  assert.equal(el['cancel-login']!.hidden,false); assert.equal(el['cancel-login']!.disabled,false);
  assert.equal(el.selection!.hidden,true); assert.equal(el.auto!.disabled,false);
  assert.match(el['password-status']!.textContent, /自动填充并登录/);
  el.auto!.checked=false; await el.auto!.onchange!();
  assert.deepEqual(optionCalls,[['beta','blackboard',{rememberPassword:true,autoLogin:false}]]);
  assert.equal(el.auto!.checked,false); assert.equal(el.remember!.checked,true);
  assert.match(el['password-status']!.textContent, /由你点击登录/);
  assert.equal(el['cancel-login']!.hidden,false);
  await el['cancel-login']!.onclick!(); assert.deepEqual(actions,['cancel']);
  assert.equal(el['cancel-login']!.hidden,true); assert.equal(el.login!.disabled,false);
  assert.equal(el.auto!.checked,false); assert.equal(el.remember!.checked,true);
  assert.match(el.status!.textContent,/已取消/);
});
test('failed cancellation remains retryable and idle pages hide cancel controls', async () => {
  const { elements: el,update } = await page({ profiles:[b],busy:true },true);
  await el['cancel-login']!.onclick!(); assert.equal(el['cancel-login']!.disabled,false);
  assert.match(el.status!.textContent,/Esc/);
  update({profiles:[b]}); assert.equal(el['cancel-login']!.hidden,true);
});
test('the active school platform controls preferences and trusted URL in the compact toolbar', async () => {
  const { elements: el, optionCalls } = await page({profiles:[{...a,blackboard:b.blackboard}],lockedProfile:a.id,lockedPlatform:'all',currentPlatform:'blackboard',busy:true,loginUrl:'https://login.example.edu/signin'});
  assert.equal(el.selection!.hidden,true); assert.equal(el.platform!.value,'blackboard');
  assert.equal(el.origins!.textContent,'https://login.example.edu/signin');
  el.remember!.checked=true; await el.remember!.onchange!();
  assert.deepEqual(optionCalls,[['alpha','blackboard',{rememberPassword:true,autoLogin:false}]]);
});
