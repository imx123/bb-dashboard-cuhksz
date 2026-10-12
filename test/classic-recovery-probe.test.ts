import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedRecoveryRead } from '../src/classic/recovery-probe.js';

test('a suspended page script cannot block recovery inspection indefinitely', async () => {
  const result = await boundedRecoveryRead(() => new Promise(() => {}), 20);
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  assert.deepEqual(await boundedRecoveryRead(async () => { throw new Error('script rejected'); }), { ok: false, reason: 'failed' });
  assert.deepEqual(await boundedRecoveryRead(async () => false), { ok: true, value: false });
});
