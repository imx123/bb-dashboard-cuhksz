import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTotpSecret, TotpRecordSchema, totpCode } from '../src/auth/totp.js';
import { LoginAttempt } from '../src/auth/preferences.js';

const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const record = TotpRecordSchema.parse({ version: 1, ...parseTotpSecret(seed) });
const credential = { form: { page: 'https://login.example.edu/signin', action: 'https://login.example.edu/session', usernameField: 'username', passwordField: 'password' }, username: 'student', password: 'secret' };

test('TOTP follows RFC 6238 vectors and accepts authenticator URIs', () => {
  assert.equal(totpCode(record, 59_000), '287082');
  assert.equal(totpCode(record, 1_111_111_090_000), '081804');
  assert.equal(totpCode(record, 1_234_567_890_000), '005924');
  const parsed = parseTotpSecret(`otpauth://totp/PolyU:student?secret=${seed}&issuer=PolyU&digits=8&period=30&algorithm=SHA1`);
  assert.deepEqual(parsed, { secret: seed, algorithm: 'SHA1', digits: 8, period: 30 });
  assert.throws(() => parseTotpSecret('not-a-secret'));
});

test('TOTP fill is opt-in, verified-origin scoped, one-shot and cancellable', () => {
  const form = { page: credential.form.page, action: credential.form.action, otpField: 'otp' };
  const attempt = new LoginAttempt({ version: 1, rememberPassword: true, autoLogin: true, credential }, record);
  assert.equal(attempt.fillOtp('https://evil.example.edu/mfa', form), null);
  const filled = attempt.fillOtp(credential.form.page, form);
  assert.equal(filled?.code.length, 6);
  assert.equal(attempt.fillOtp(credential.form.page, form), null);
  assert.equal(attempt.canSubmitOtp(credential.form.page, form), true);
  attempt.stopAutomation();
  assert.equal(attempt.canSubmitOtp(credential.form.page, form), false);
  const manual = new LoginAttempt({ version: 1, rememberPassword: true, autoLogin: false, credential }, record);
  assert.equal(manual.fillOtp(credential.form.page, form), null);
});
