import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClassicError } from '../src/classic/errors.js';
import { classicUrl, requireClassicUrl, safeDownloadPath } from '../src/classic/url-policy.js';
import { sanitizeRichBody } from '../src/classic/rich-text.js';
import { classicDashboardHTML } from '../src/dashboard/classic-ui.js';

test('Classic source URLs remain fixed-origin and download names cannot escape their directory', () => {
  assert.equal(classicUrl('https://bb.cuhk.edu.cn/webapps/blackboard/x'), 'https://bb.cuhk.edu.cn/webapps/blackboard/x');
  for (const value of ['javascript:alert(1)', 'https://evil.example/x', 'http://bb.cuhk.edu.cn/x', 'https://me:p@bb.cuhk.edu.cn/x', 'https://bb.cuhk.edu.cn:444/x']) {
    assert.equal(classicUrl(value), undefined);
  }
  assert.throws(() => requireClassicUrl('file:///secret'), (error: unknown) => error instanceof ClassicError && error.code === 'URL_REJECTED');
  const root = join(tmpdir(), 'classic-download-test');
  assert.equal(safeDownloadPath(root, '../report.pdf'), join(root, 'report.pdf'));
});

test('Dashboard has one nonce-authorized inline script with a valid renderer program', () => {
  const html = classicDashboardHTML();
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const attributes = scripts[0]![1]!;
  const program = scripts[0]![2]!;
  const nonce = /\bnonce="([^"]+)"/.exec(attributes)?.[1];
  assert.ok(nonce);
  assert.ok(html.includes(`script-src 'nonce-${nonce}'`));
  assert.match(html, /default-src 'none'/);
  assert.match(html, /img-src data:/);
  assert.doesNotMatch(attributes, /\bsrc\s*=/);
  assert.doesNotThrow(() => new Script(program));
});

test('RichBody keeps useful formatting while removing executable markup and external images', () => {
  const registered: string[] = [];
  const body = sanitizeRichBody(
    '<table><tr><td><strong>Assignment</strong></td></tr></table>'
      + '<script>window.stolen=true</script><iframe src="https://evil.example"></iframe>'
      + '<a href="javascript:alert(1)" onclick="alert(1)">Unsafe link</a>'
      + '<img src="/bbcswebdav/xid-12_1" onerror="alert(1)" alt="Course image">'
      + '<img src="https://evil.example/image.png">',
    {
      baseUrl: 'https://bb.cuhk.edu.cn/webapps/blackboard/content/listContent.jsp',
      registerImage: (url, alt) => {
        registered.push(url);
        return { resourceId: 'synthetic-image', alt };
      },
    },
  );
  assert.ok(body.sanitizedHtml);
  assert.match(body.sanitizedHtml, /<table>/);
  assert.match(body.sanitizedHtml, /<strong>Assignment<\/strong>/);
  assert.doesNotMatch(body.sanitizedHtml, /<script\b|<iframe\b|\bonerror\s*=|\bonclick\s*=|javascript:|evil\.example|window\.stolen/i);
  assert.deepEqual(registered, ['https://bb.cuhk.edu.cn/bbcswebdav/xid-12_1']);
  assert.equal(body.images.length, 1);
  assert.match(body.sanitizedHtml, /lms-resource:\/\/resource\/synthetic-image/);
});
