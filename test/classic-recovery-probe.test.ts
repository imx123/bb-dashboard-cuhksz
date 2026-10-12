import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedRecoveryRead, probeRecoveryIdentity } from '../src/classic/recovery-probe.js';

test('a suspended page script cannot block recovery inspection indefinitely', async () => {
  const result = await boundedRecoveryRead(() => new Promise(() => {}), 20);
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  assert.deepEqual(await boundedRecoveryRead(async () => { throw new Error('script rejected'); }), { ok: false, reason: 'failed' });
  assert.deepEqual(await boundedRecoveryRead(async () => false), { ok: true, value: false });
});

test('identity probe can detect authenticated landing without any SSO navigation event', async () => {
  let calls = 0;
  const result = await probeRecoveryIdentity(async (url, init) => {
    calls++;
    assert.equal(url, 'https://bb.cuhk.edu.cn/learn/api/v1/users/me');
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'include');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers, undefined, 'Chromium owns cookies; no exported Cookie header');
    return Response.json({ id: '_synthetic_1' });
  }, new AbortController().signal);
  assert.deepEqual(result, { authenticated: true, status: 200 });
  assert.equal(calls, 1);
});

test('expired session and HTML login pages do not prove authentication', async () => {
  const signal = new AbortController().signal;
  assert.deepEqual(await probeRecoveryIdentity(async () => new Response('', { status: 401 }), signal), { authenticated: false, status: 401 });
  assert.equal((await probeRecoveryIdentity(async () => new Response('<html>Login</html>'), signal)).authenticated, false);
  assert.equal((await probeRecoveryIdentity(async () => Response.json({ results: [] }), signal)).authenticated, false);
});

test('oversized identity response is cancelled rather than accepted', async () => {
  const result = await probeRecoveryIdentity(async () => new Response('x'.repeat(32769)), new AbortController().signal);
  assert.deepEqual(result, { authenticated: false, status: 200, reason: 'oversize' });
});

test('cancellation stops identity probing without inventing a valid session', async () => {
  const controller = new AbortController();
  const result = probeRecoveryIdentity(async (_url, init) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), controller.signal);
  controller.abort();
  assert.deepEqual(await result, { authenticated: false, reason: 'aborted-or-timeout' });
});
