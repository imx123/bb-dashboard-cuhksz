import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClassicSnapshotCache, mergeSnapshotWithCache } from '../src/classic/cache.js';
import { parseSnapshotResult, parseStatusResult } from '../src/classic/adapter.js';
import { ClassicError } from '../src/classic/errors.js';
import { CLASSIC_READ_TOOLS, classicUserDataDir, ClassicMcpClient, resolveClassicRuntime } from '../src/classic/mcp-client.js';
import { ClassicProvider } from '../src/classic/provider.js';
import { SnapshotSchema } from '../src/classic/schema.js';
import { classicUrl, requireClassicUrl, safeDownloadPath } from '../src/classic/url-policy.js';
import { classicDashboardHTML } from '../src/dashboard/classic-ui.js';

const fixtureSnapshot = (dueAt: string | null = '2026-10-30T23:59:00+08:00') => ({
  state: 'ok', fetchedAt: '2026-10-10T12:00:00+08:00', timezone: 'Asia/Shanghai',
  courses: [{ id: '_123456_1', name: '网络与系统课程', code: null, url: 'https://bb.cuhk.edu.cn/webapps/blackboard/execute/launcher?type=Course&id=_123456_1&url=' }],
  announcements: [{ id: 'announcement:1', courseId: '_123456_1', title: '考试安排', body: '<script>不执行</script>', publishedAt: null, url: null, unread: null }],
  assignments: [
    { id: 'assignment:1', courseId: '_123456_1', title: '期末项目', dueAt, dueDateOnly: null, dueEvidence: 'blackboard-field', url: 'https://bb.cuhk.edu.cn/webapps/assessment/do?x=1', remoteSubmission: 'unknown', summary: null, attachments: [] },
    { id: 'assignment:2', courseId: '_123456_1', title: '阅读报告', dueAt: null, dueDateOnly: '2026-10-20', dueEvidence: 'page-text', url: null, remoteSubmission: 'unknown', summary: null, attachments: [] },
    { id: 'assignment:3', courseId: '_123456_1', title: '待核实项目', dueAt: null, dueDateOnly: null, dueEvidence: 'unknown', url: 'javascript:alert(1)', remoteSubmission: 'unknown', summary: null, attachments: [] },
  ],
  files: [{ id: 'file:1', courseId: '_123456_1', name: '讲义.pdf', url: 'https://bb.cuhk.edu.cn/webapps/blackboard/content/file.pdf', publishedAt: null }],
  errors: [],
});

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

function fakeClient(payload = fixtureSnapshot(), status = { state: 'ok', authenticated: true, next: null }, login = { state: 'ok' }) {
  const calls: string[] = [];
  const client = new ClassicMcpClient({
    sidecarRoot: join(process.cwd(), 'sidecar', 'bb-mcp'),
    connectTimeoutMs: 500,
    callTimeoutMs: 500,
    retryCount: 0,
    connectionFactory: async () => ({
      client: { callTool: async (request: { name: string }) => { calls.push(request.name); return result(request.name === 'classic_status' ? status : request.name === 'classic_snapshot' ? payload : request.name === 'classic_login' ? login : { state: 'ok' }); } } as never,
      transport: { close: async () => {} } as never,
      tools: new Map(CLASSIC_READ_TOOLS.map(name => [name, { name, inputSchema: { type: 'object' } }])),
      close: async () => {},
    } as never),
  });
  return { client, calls };
}

test('Classic schema accepts connector nulls and keeps unknown DDL distinct from date-only', () => {
  const parsed = SnapshotSchema.parse(fixtureSnapshot());
  assert.equal(parsed.courses[0]?.code, null);
  assert.equal(parsed.assignments[0]?.dueAt, '2026-10-30T23:59:00+08:00');
  assert.equal(parsed.assignments[1]?.dueDateOnly, '2026-10-20');
  assert.equal(parsed.assignments[2]?.dueAt, null);
});

test('Classic adapter consumes structured snapshot, rejects unsafe links, and preserves explicit source fields', () => {
  const parsed = parseSnapshotResult(result(fixtureSnapshot()));
  assert.equal(parsed.courses.length, 1);
  assert.equal(parsed.assignments.find(item => item.id === 'assignment:3')?.url, null);
  assert.equal(parsed.assignments.find(item => item.id === 'assignment:2')?.dueAt, null);
  assert.equal(parsed.assignments.find(item => item.id === 'assignment:2')?.dueDateOnly, '2026-10-20');
  assert.equal(parsed.announcements[0]?.body, '<script>不执行</script>');
  assert.throws(() => parseSnapshotResult(result({ state: 'ok', courses: [] })), (error: unknown) => error instanceof ClassicError && error.code === 'RESULT_PARSE_FAILED');
  assert.throws(() => parseSnapshotResult(result({ ...fixtureSnapshot(), state: 'unknown' })), (error: unknown) => error instanceof ClassicError && error.code === 'RESULT_PARSE_FAILED');
  assert.throws(() => parseSnapshotResult(result({ ...fixtureSnapshot(), timezone: 'UTC' })), (error: unknown) => error instanceof ClassicError && error.code === 'RESULT_PARSE_FAILED');
});

test('Classic snapshot rejects malformed resource records instead of silently showing empty success', () => {
  for (const field of ['announcements', 'assignments', 'files'] as const) {
    const malformed = { ...fixtureSnapshot(), [field]: [{ courseId: '_123456_1' }] };
    assert.throws(() => parseSnapshotResult(result(malformed)), (error: unknown) => error instanceof ClassicError && error.code === 'RESULT_PARSE_FAILED', field);
  }
});

test('status parser does not turn malformed or unauthenticated output into success', () => {
  assert.deepEqual(parseStatusResult(result({ state: 'ok', authenticated: true, next: null })), { state: 'ok', authenticated: true, next: null, errors: [] });
  assert.throws(() => parseStatusResult(result({ state: 'ok' })), (error: unknown) => error instanceof ClassicError && error.code === 'RESULT_PARSE_FAILED');
  assert.deepEqual(parseStatusResult(result({ state: 'auth-required', authenticated: false, next: 'login', errors: [{ scope: 'auth', code: 'AUTH_REQUIRED', message: '需要完成登录' }] })), { state: 'auth-required', authenticated: false, next: 'login', errors: [{ scope: 'auth', code: 'AUTH_REQUIRED', message: '需要完成登录' }] });
  assert.throws(() => parseStatusResult(result({ state: 'auth-required', authenticated: false, next: 'login', errors: [{ scope: 'auth' }] })), (error: unknown) => error instanceof ClassicError && error.code === 'RESULT_PARSE_FAILED');
});

test('status parser preserves bounded auth diagnostics without query or fragment data', () => {
  const authResult = {
    phase: 'current-page', origin: 'https://bb.cuhk.edu.cn', pathname: '/webapps/portal/execute/tabs/tabAction',
    portalTarget: '/webapps/portal/execute/tabs/tabAction', portalCandidate: true, courseLinkCount: 3,
    marker: true, iframeCount: 1, explicitLoginForm: false,
  } as const;
  const parsed = parseStatusResult(result({ state: 'error', authenticated: false, next: 'retry', errors: [{ scope: 'auth', code: 'AUTH_CHECK_UNRECOGNIZED', message: '页面未识别' }], authResult }));
  assert.equal(parsed.authResult?.pathname, '/webapps/portal/execute/tabs/tabAction');
  assert.equal(parsed.authResult?.courseLinkCount, 3);
  assert.throws(() => parseStatusResult(result({ state: 'error', authenticated: false, next: 'retry', errors: [], authResult: { ...authResult, pathname: '/bad?secret=1' } })), (error: unknown) => error instanceof ClassicError && error.code === 'RESULT_PARSE_FAILED');
});

test('Classic URL policy is exact and download names cannot escape the selected directory', () => {
  assert.equal(classicUrl('https://bb.cuhk.edu.cn/webapps/blackboard/x'), 'https://bb.cuhk.edu.cn/webapps/blackboard/x');
  for (const value of ['javascript:alert(1)', 'https://evil.example/x', 'http://bb.cuhk.edu.cn/x', 'https://me:p@bb.cuhk.edu.cn/x', 'https://bb.cuhk.edu.cn:444/x']) assert.equal(classicUrl(value), undefined);
  assert.throws(() => requireClassicUrl('file:///secret'), (error: unknown) => error instanceof ClassicError && error.code === 'URL_REJECTED');
  const root = join(tmpdir(), 'classic-download-test');
  assert.equal(safeDownloadPath(root, '../report.pdf'), join(root, 'report.pdf'));
});

test('MCP client allows only classic read/login tools and uses course_id', async () => {
  const { client, calls } = fakeClient();
  await assert.rejects(client.call('bb_list_courses'), (error: unknown) => error instanceof ClassicError && error.code === 'TOOL_NOT_ALLOWED');
  await assert.rejects(client.call('classic_announcements', { course: '_123456_1' }), (error: unknown) => error instanceof ClassicError && error.code === 'BAD_INPUT');
  await assert.rejects(client.call('classic_snapshot', { limits: { assignments: 101 } }), (error: unknown) => error instanceof ClassicError && error.code === 'BAD_INPUT');
  await assert.rejects(client.call('classic_snapshot', { unexpected: true }), (error: unknown) => error instanceof ClassicError && error.code === 'BAD_INPUT');
  await assert.rejects(client.call('classic_list_course_files', { course_id: '_123456_1', limit: 0 }), (error: unknown) => error instanceof ClassicError && error.code === 'BAD_INPUT');
  await client.call('classic_announcements', { course_id: '_123456_1', limit: 8 });
  assert.deepEqual(calls, ['classic_announcements']);
  await client.close();
});

test('live runtime removes inherited fixture env while fixture mode sets only BB_OFFLINE_FIXTURE', () => {
  const previous = process.env.BB_OFFLINE_FIXTURE;
  const previousProfile = process.env.BB_USER_DATA_DIR;
  try {
    process.env.BB_OFFLINE_FIXTURE = 'E:/stale-fixture';
    process.env.BB_USER_DATA_DIR = 'E:/stale-profile';
    assert.throws(() => resolveClassicRuntime({ mode: 'live', sidecarRoot: join(process.cwd(), 'sidecar', 'bb-mcp') }), (error: unknown) => error instanceof ClassicError && error.code === 'CONNECTOR_START_FAILED');
    const liveA = resolveClassicRuntime({ mode: 'live', userDataDir: classicUserDataDir('profile-a|https://bb.cuhk.edu.cn|live'), sidecarRoot: join(process.cwd(), 'sidecar', 'bb-mcp') });
    const liveB = resolveClassicRuntime({ mode: 'live', userDataDir: classicUserDataDir('profile-b|https://bb.cuhk.edu.cn|live'), sidecarRoot: join(process.cwd(), 'sidecar', 'bb-mcp') });
    assert.notEqual(liveA.env.BB_USER_DATA_DIR, liveB.env.BB_USER_DATA_DIR);
    assert.match(liveA.env.BB_USER_DATA_DIR ?? '', /classic-profiles/);
    assert.equal(liveA.env.BB_OFFLINE_FIXTURE, undefined);
    const fixture = resolveClassicRuntime({ mode: 'offline-fixture', fixturePath: join(process.cwd(), 'test', 'fixtures', 'classic'), sidecarRoot: join(process.cwd(), 'sidecar', 'bb-mcp') });
    assert.equal(fixture.env.BB_OFFLINE_FIXTURE, join(process.cwd(), 'test', 'fixtures', 'classic'));
    assert.equal(fixture.env.BB_USER_DATA_DIR, undefined);
  } finally {
    if (previous === undefined) delete process.env.BB_OFFLINE_FIXTURE;
    else process.env.BB_OFFLINE_FIXTURE = previous;
    if (previousProfile === undefined) delete process.env.BB_USER_DATA_DIR;
    else process.env.BB_USER_DATA_DIR = previousProfile;
  }
});

test('Provider filters the view while caching the complete snapshot for a later 30-day load', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'classic-cache-'));
  try {
    const { client } = fakeClient();
    const provider = new ClassicProvider({ client, cache: new ClassicSnapshotCache(join(directory, 'cache.json')), scope: 'fixture-account', source: 'offline-fixture' });
    const short = await provider.load(7);
    assert.equal(short.assignments.some(item => item.id === 'assignment:1'), false);
    const long = await provider.load(30);
    assert.equal(long.assignments.some(item => item.id === 'assignment:1'), true);
    await provider.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Provider status is conservative when authenticated state is false', async () => {
  const { client } = fakeClient(fixtureSnapshot(), { state: 'auth-required', authenticated: false, next: 'login' });
  const provider = new ClassicProvider({ client, source: 'offline-fixture', cache: new ClassicSnapshotCache(join(tmpdir(), 'unused-classic-cache.json')) });
  const status = await provider.status();
  assert.equal(status.ok, false);
  assert.equal(status.error?.code, 'AUTH_REQUIRED');
  await provider.close();
});

test('Provider login does not treat state=ok without authenticated=true as success', async () => {
  const { client } = fakeClient();
  const provider = new ClassicProvider({ client, source: 'offline-fixture', cache: new ClassicSnapshotCache(join(tmpdir(), 'unused-classic-login-cache.json')) });
  const login = await provider.login('complete');
  assert.equal(login.ok, false);
  assert.equal(login.error?.code, 'RESULT_PARSE_FAILED');
  await provider.close();
});

test('Provider login exposes the expected browser-pending state and connector error envelope', async () => {
  const pendingClient = fakeClient(fixtureSnapshot(), { state: 'ok', authenticated: true, next: null }, { state: 'auth-required', authenticated: false, next: 'browser', errors: [] }).client;
  const pending = new ClassicProvider({ client: pendingClient, source: 'live', cache: new ClassicSnapshotCache(join(tmpdir(), 'unused-classic-pending-cache.json')) });
  const waiting = await pending.login('begin');
  assert.deepEqual(waiting, { ok: false, state: 'auth-required', next: 'browser' });
  await pending.close();

  const rejectedClient = fakeClient(fixtureSnapshot(), { state: 'ok', authenticated: true, next: null }, { state: 'auth-required', authenticated: false, next: 'complete', errors: [{ scope: 'auth', code: 'AUTH_REQUIRED', message: '官方会话仍未验证' }] }).client;
  const rejected = new ClassicProvider({ client: rejectedClient, source: 'live', cache: new ClassicSnapshotCache(join(tmpdir(), 'unused-classic-rejected-cache.json')) });
  const result = await rejected.login('complete');
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'AUTH_REQUIRED');
  assert.equal(result.error?.message, '官方会话仍未验证');
  await rejected.close();
});

test('Provider login keeps auth-check-unrecognized diagnostic and preserves complete retry action', async () => {
  const diagnosticClient = fakeClient(fixtureSnapshot(), { state: 'ok', authenticated: true, next: null }, {
    state: 'error', authenticated: false, next: 'complete',
    errors: [{ scope: 'auth', code: 'AUTH_CHECK_UNRECOGNIZED', message: '认证页面未识别' }],
    authResult: {
      phase: 'current-page', origin: 'https://bb.cuhk.edu.cn', pathname: '/webapps/portal/execute/tabs/tabAction',
      portalTarget: '/webapps/portal/execute/tabs/tabAction', portalCandidate: true, courseLinkCount: 2,
      marker: false, iframeCount: 1, explicitLoginForm: false,
    },
  }).client;
  const provider = new ClassicProvider({ client: diagnosticClient, source: 'live', cache: new ClassicSnapshotCache(join(tmpdir(), 'unused-classic-auth-check-cache.json')) });
  const login = await provider.login('complete');
  assert.equal(login.ok, false);
  assert.equal(login.state, 'error');
  assert.equal(login.error?.code, 'AUTH_CHECK_UNRECOGNIZED');
  assert.match(login.error?.message ?? '', /pathname=\/webapps\/portal\/execute\/tabs\/tabAction/);
  assert.equal(login.authResult?.courseLinkCount, 2);
  await provider.close();
});

test('Provider login keeps a structured MCP error code and message', async () => {
  const client = new ClassicMcpClient({
    sidecarRoot: join(process.cwd(), 'sidecar', 'bb-mcp'),
    connectTimeoutMs: 500,
    callTimeoutMs: 500,
    retryCount: 0,
    connectionFactory: async () => ({
      client: { callTool: async () => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: 'TIMEOUT', message: '启动本地登录浏览器超时' } }) }] }) } as never,
      transport: { close: async () => {} } as never,
      tools: new Map(CLASSIC_READ_TOOLS.map(name => [name, { name, inputSchema: { type: 'object' } }])),
      close: async () => {},
    } as never),
  });
  const provider = new ClassicProvider({ client, source: 'live', cache: new ClassicSnapshotCache(join(tmpdir(), 'unused-classic-envelope-cache.json')) });
  const login = await provider.login('begin');
  assert.equal(login.ok, false);
  assert.equal(login.error?.code, 'TIMEOUT');
  assert.equal(login.error?.message, '启动本地登录浏览器超时');
  await provider.close();
});

test('cache merge keeps current successful resources and previous resources on a per-section failure', () => {
  const previous = SnapshotSchema.parse(fixtureSnapshot());
  const current = SnapshotSchema.parse({ ...fixtureSnapshot(), announcements: [], errors: [{ scope: 'course:_123456_1:announcements', code: 'FORBIDDEN', message: '拒绝访问' }] });
  const merged = mergeSnapshotWithCache(current, previous);
  assert.equal(merged.announcements.length, previous.announcements.length);
  assert.equal(merged.files.length, current.files.length);
  assert.equal(merged.errors.some(error => error.code === 'CACHE_FALLBACK'), true);
  assert.ok((merged.errors.find(error => error.code === 'CACHE_FALLBACK')?.message ?? '').includes(previous.fetchedAt));
});

test('cache merge falls back only for the failed course and does not resurrect another course', () => {
  const secondCourse = { id: '_234567_1', name: '第二门课程', code: null, url: null };
  const previous = SnapshotSchema.parse({
    ...fixtureSnapshot(),
    fetchedAt: '2026-10-09T12:00:00+08:00',
    courses: [...fixtureSnapshot().courses, secondCourse],
    announcements: [
      ...fixtureSnapshot().announcements,
      { id: 'announcement:old-second', courseId: secondCourse.id, title: '旧公告', body: '旧内容', publishedAt: null, url: null, unread: null },
    ],
  });
  const current = SnapshotSchema.parse({
    ...previous,
    fetchedAt: '2026-10-10T12:00:00+08:00',
    announcements: [
      { id: 'announcement:new-first', courseId: '_123456_1', title: '新公告', body: '新内容', publishedAt: null, url: null, unread: null },
    ],
    errors: [{ scope: 'course:_123456_1:announcements', code: 'FORBIDDEN', message: '拒绝访问' }],
  });
  const merged = mergeSnapshotWithCache(current, previous);
  assert.deepEqual(merged.announcements.map(item => item.id).sort(), ['announcement:1', 'announcement:new-first']);
  assert.equal(merged.announcements.some(item => item.id === 'announcement:old-second'), false);
  assert.ok((merged.errors.find(error => error.code === 'CACHE_FALLBACK')?.message ?? '').includes(previous.fetchedAt));
});

test('Classic dashboard UI is a text-only, CSP constrained renderer surface', () => {
  const html = classicDashboardHTML();
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
  assert.match(html, /Blackboard Classic/);
  assert.match(html, /离线演示/);
  assert.doesNotMatch(html, /innerHTML|<script src=/);
  assert.match(html, /textContent/);
  assert.match(html, /timeZone:'Asia\/Shanghai'/);
  assert.match(html, /浏览器已打开/);
  assert.match(html, /我已登录，检查连接/);
  assert.match(html, /重新打开登录窗口/);
  assert.match(html, /loginError/);
});

test('real stdio Python sidecar fixture reaches the Node provider without school credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'classic-stdio-'));
  const client = new ClassicMcpClient({ mode: 'offline-fixture', fixturePath: join(process.cwd(), 'test', 'fixtures', 'classic'), connectTimeoutMs: 5_000, callTimeoutMs: 10_000 });
  try {
    const provider = new ClassicProvider({ client, source: 'offline-fixture', scope: 'stdio-fixture', cache: new ClassicSnapshotCache(join(directory, 'cache.json')) });
    const snapshot = await provider.load(30);
    assert.equal(snapshot.source, 'offline-fixture');
    assert.equal(snapshot.state, 'ok');
    assert.equal(snapshot.courses.length, 3);
    assert.ok(snapshot.announcements.length > 0);
    assert.ok(snapshot.assignments.length > 0);
    assert.ok(snapshot.files.length > 0);
    await provider.close();
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});
