import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvedLoginTarget, literalLoginTarget } from '../src/classic/login-target.js';

const origin = 'https://bb.cuhk.edu.cn';
const origins = new Set([origin, 'https://sts.cuhk.edu.cn']);
// Public OAuth client ID and callback copied from the official anonymous login page.
const target = 'https://STS.cuhk.edu.cn/adfs/oauth2/authorize?response_type=code&client_id=4b71b947-7b0d-4611-b47e-0ec37aabfd5e&redirect_uri=https://bb.cuhk.edu.cn/webapps/bb-SSOIntegrationOAuth2-BBLEARN/authValidate/getCode';

test('official LOGIN button provides the OAuth2 navigation URL without evaluating its handler', () => {
  const value = literalLoginTarget(`location.href=("${target}")`);
  assert.equal(value, target);
  const approved = approvedLoginTarget(value!, origin, origins);
  assert.equal(new URL(approved!).origin, 'https://sts.cuhk.edu.cn');
  assert.equal(new URL(approved!).search, new URL(target).search);
});

test('dynamic scripts and unrelated redirects cannot be used as a login target', () => {
  for (const value of ['location.href=getLoginUrl()', 'alert(1);location.href="https://sts.cuhk.edu.cn"', 'location.href=("https://sts.cuhk.edu.cn");submitPassword()']) {
    assert.equal(literalLoginTarget(value), null);
  }
  const externalCallback = new URL(target);
  externalCallback.searchParams.set('redirect_uri', 'https://evil.example/callback');
  assert.equal(approvedLoginTarget(externalCallback.href, origin, origins), null);
  assert.equal(approvedLoginTarget(target, origin, new Set([origin])), null);
  assert.equal(approvedLoginTarget('https://sts.cuhk.edu.cn/adfs/logout', origin, origins), null);
});

test('the existing same-origin SAML login link remains supported', () => {
  assert.equal(approvedLoginTarget('/auth-saml/saml/login?provider=example', origin, origins), `${origin}/auth-saml/saml/login?provider=example`);
});
