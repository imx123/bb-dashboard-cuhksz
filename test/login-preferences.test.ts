import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Vault } from '../src/vault.js';
import { LoginStore, LoginCredential, LoginAttempt, loginSummary, loginPage, matchesLoginForm, canRestoreLogin } from '../src/auth/preferences.js';
import type { Profile } from '../src/config.js';

const p: Profile = { id: 'fixture', label: 'Synthetic', timezone: 'UTC', blackboard: 'https://learn.example.edu' };
const credential = { form: { page: 'https://login.example.edu/signin', action: 'https://login.example.edu/session', usernameField: 'username', passwordField: 'password' }, username: 'synthetic-student', password: 'synthetic-secret-NOT-REAL' };
test('both remembered modes open the school page without a second launcher click', () => {
  const fillOnly = { rememberPassword: true, autoLogin: false, hasPassword: true };
  assert.equal(canRestoreLogin(['blackboard'], { blackboard: fillOnly }), true);
  assert.equal(canRestoreLogin(['blackboard'], { blackboard: { ...fillOnly, autoLogin: true } }), true);
  assert.equal(canRestoreLogin(['blackboard'], { blackboard: { ...fillOnly, hasPassword: false } }), false);
  assert.equal(canRestoreLogin(['blackboard'], { blackboard: { ...fillOnly, rememberPassword: false } }), false);
  assert.equal(canRestoreLogin(['canvas'], { blackboard: fillOnly }), false);
  assert.equal(canRestoreLogin(['canvas', 'blackboard'], { blackboard: fillOnly }), false);
  assert.equal(canRestoreLogin(['canvas', 'blackboard'], { canvas: fillOnly, blackboard: { ...fillOnly, autoLogin: true } }), true);
  assert.equal(canRestoreLogin([]), false);
});
test('remembered passwords are opt-in, encrypted, scoped and erased on opt-out/logout', async () => {
  const home = await mkdtemp(join(tmpdir(), 'lms-login-test-')); const previousHome = process.env.LMS_HOME; process.env.LMS_HOME = home;
  try {
    const key = randomBytes(32); const vault = new Vault({ get: async () => key, set: async () => {} }); const store = new LoginStore(vault);
    assert.deepEqual(loginSummary(await store.read(p, 'blackboard')), { rememberPassword: false, autoLogin: false, hasPassword: false });
    await store.saveVerified(p, 'blackboard', credential); assert.equal(await store.read(p, 'blackboard'), null);
    await assert.rejects(store.setOptions(p, 'blackboard', { rememberPassword: false, autoLogin: true }));
    await store.setOptions(p, 'blackboard', { rememberPassword: true, autoLogin: false });
    assert.equal(loginSummary(await store.read(p, 'blackboard')).hasPassword, false);
    await store.saveVerified(p, 'blackboard', credential);
    assert.deepEqual((await store.read(p, 'blackboard'))!.credential, credential);
    for (const file of (await readdir(home)).filter(f => f.endsWith('.vault'))) {
      const raw = await readFile(join(home, file), 'utf8'); assert(!raw.includes(credential.password)); assert(!raw.includes(credential.username));
    }
    assert.equal(await store.read({ ...p, id: 'other' }, 'blackboard'), null);
    assert.equal(await store.read({ ...p, blackboard: 'https://other.example.edu' }, 'blackboard'), null);
    assert.equal(await store.read(p, 'canvas'), null);
    await store.setOptions(p, 'blackboard', { rememberPassword: true, autoLogin: true });
    assert.equal(loginSummary(await store.read(p, 'blackboard')).autoLogin, true);
    await store.setTotp(p, 'blackboard', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.equal(loginSummary(await store.read(p, 'blackboard'), await store.readTotp(p, 'blackboard')).totpConfigured, true);
    await store.setOptions(p, 'blackboard', { rememberPassword: false, autoLogin: false });
    assert.equal(await store.readTotp(p, 'blackboard'), null);
    await store.saveVerified(p, 'blackboard', credential); assert.equal(await store.read(p, 'blackboard'), null);
    await store.setOptions(p, 'blackboard', { rememberPassword: true, autoLogin: true });
    await store.saveVerified(p, 'blackboard', credential);
    await vault.write(p, 'blackboard', { kind: 'synthetic-session' });
    await vault.remove(p, 'blackboard');
    assert.equal(await store.read(p, 'blackboard'), null); assert.equal(await store.readTotp(p, 'blackboard'), null); assert.equal(await vault.read(p, 'blackboard'), null);
  } finally { if (previousHome === undefined) delete process.env.LMS_HOME; else process.env.LMS_HOME = previousHome; await rm(home, { recursive: true, force: true }); }
});
test('saved login matches exact HTTPS page, action and field identities', () => {
  assert.equal(loginPage('https://login.example.edu/signin?state=private#nonce'), credential.form.page);
  assert.equal(loginPage('http://login.example.edu/signin'), null);
  assert.equal(loginPage('https://user:secret@login.example.edu/signin'), null);
  assert(matchesLoginForm(credential, credential.form));
  for (const form of [ { ...credential.form, page: 'https://evil.example.edu/signin' }, { ...credential.form, page: 'https://login.example.edu/course' }, { ...credential.form, action: 'https://evil.example.edu/session' }, { ...credential.form, passwordField: 'otp' } ]) assert.equal(matchesLoginForm(credential, form), false);
  assert.equal(LoginCredential.safeParse({ ...credential, password: '' }).success, false);
  const crossOrigin = { ...credential, form: { ...credential.form, action: 'https://idp.example.edu/auth' } };
  assert.equal(LoginCredential.safeParse(crossOrigin).success, true);
  assert(matchesLoginForm(crossOrigin, crossOrigin.form));
});
test('login attempts cannot expose credentials to other pages or automatically retry', () => {
  const disabled = new LoginAttempt(null); disabled.capture(credential.form.page, credential);
  assert.equal(disabled.candidate, undefined); assert.equal(disabled.fill(credential.form.page, credential.form), null);
  const attempt = new LoginAttempt({ version: 1, rememberPassword: true, autoLogin: false, credential });
  assert.equal(attempt.fill('https://evil.example.edu/signin', credential.form), null);
  assert.equal(attempt.fill(credential.form.page, { ...credential.form, action: 'https://evil.example.edu/session' }), null);
  assert.deepEqual(attempt.fill(credential.form.page, credential.form), { username: credential.username, password: credential.password, autoLogin: false });
  assert.equal(attempt.fill(credential.form.page, credential.form), null);
  attempt.capture('https://evil.example.edu/signin', credential); assert.equal(attempt.candidate, undefined);
  attempt.capture(credential.form.page, credential); assert.deepEqual(attempt.candidate, credential);
  const automatic = new LoginAttempt({ version: 1, rememberPassword: true, autoLogin: true, credential });
  assert.equal(automatic.fill(credential.form.page, credential.form)!.autoLogin, true);
  assert.equal(automatic.fill(credential.form.page, credential.form), null);
});
test('stopping revokes pending fill/submit; cancellation clears captured credentials', () => {
  const record={version:1 as const,rememberPassword:true as const,autoLogin:true,credential};
  const attempt=new LoginAttempt(record);
  assert.equal(attempt.canSubmit(credential.form.page,credential.form),true);
  assert(attempt.fill(credential.form.page,credential.form));
  attempt.stopAutomation();
  assert.equal(attempt.canSubmit(credential.form.page,credential.form),false);
  assert.equal(attempt.fill(credential.form.page,credential.form),null);
  attempt.capture(credential.form.page,credential); assert.deepEqual(attempt.candidate,credential);
  attempt.cancel(); assert.equal(attempt.record,null); assert.equal(attempt.candidate,undefined);
  attempt.capture(credential.form.page,credential); assert.equal(attempt.candidate,undefined);
});
test('consent can be enabled on the school page and revoked before persistence completes', () => {
  const attempt = new LoginAttempt(null);
  attempt.updateOptions({rememberPassword:true,autoLogin:false});
  attempt.capture(credential.form.page,credential); assert.deepEqual(attempt.candidate,credential);
  attempt.updateOptions({rememberPassword:false,autoLogin:false});
  assert.equal(attempt.candidate,undefined); assert.equal(attempt.record,null);
  const saved = new LoginAttempt({version:1,rememberPassword:true,autoLogin:true,credential});
  saved.updateOptions({rememberPassword:true,autoLogin:false});
  assert.equal(saved.canSubmit(credential.form.page,credential.form),false);
  assert.deepEqual(saved.record?.credential,credential);
});
test('split username/password SSO steps are captured and restored by exact page/action/field', () => {
  const usernameStep = { page: 'https://login.example.edu/identifier', action: 'https://login.example.edu/identifier', field: 'user', kind: 'username' as const };
  const passwordStep = { page: 'https://idp.example.edu/password', action: 'https://idp.example.edu/password', field: 'pass', kind: 'password' as const };
  const attempt = new LoginAttempt({ version: 1, rememberPassword: true, autoLogin: false });
  attempt.captureStep(usernameStep.page, { form: usernameStep, value: 'student' });
  assert.equal(attempt.candidate, undefined);
  attempt.captureStep(passwordStep.page, { form: passwordStep, value: 'secret' });
  assert.equal(attempt.candidate?.username, 'student'); assert.equal(attempt.candidate?.password, 'secret');
  const saved = new LoginAttempt({ version: 1, rememberPassword: true, autoLogin: true, credential: attempt.candidate });
  assert.deepEqual(saved.fill(usernameStep.page, usernameStep), { step: 'username', value: 'student', autoLogin: true });
  assert.equal(saved.canSubmitStep(usernameStep.page, usernameStep), true);
  assert.deepEqual(saved.fill(passwordStep.page, passwordStep), { step: 'password', value: 'secret', autoLogin: true });
  assert.equal(saved.fill('https://evil.example.edu/password', passwordStep), null);
});
