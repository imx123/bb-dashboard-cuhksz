import { app, BrowserWindow, clipboard, ipcMain, shell, type Session as ElectronSession } from 'electron';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, getProfile, initProfile, locked, stateHome, type Profile } from '../config.js';
import { LmsError, publicError } from '../errors.js';
import { CompletionStore as LegacyCompletionStore, completionScope } from './completion-store.js';
import { classicDashboardHTML } from './classic-ui.js';
import { ClassicApiProvider } from '../classic/api-provider.js';
import { ClassicApiError, publicApiError } from '../classic/api-errors.js';
import { ClassicSnapshotCache } from '../classic/cache.js';
import { ClassicHttpClient } from '../classic/http.js';
import { ClassicSession } from '../classic/session.js';
import { ClassicResourceRegistry } from '../classic/resource.js';
import { CompletionStoreV2, completionKeyV2, legacyCompletionKey, planCompletionMigration, type CompletionMigrationPlan, type CompletionScopeV2, type LegacyCompletionScope } from '../classic/completion-migration.js';
import { requireClassicUrl } from '../classic/url-policy.js';
import { createTraceId, currentTraceId, debugLog, debugLogDirectory, runWithTrace } from '../debug-log.js';
import type { AnnouncementV2, AssignmentV2, SnapshotV2 } from '../classic/schema-v2.js';
import type { ClassicAccountContext, ClassicSession as ClassicSessionContract, ClassicSessionSnapshot } from '../classic/api-contract.js';
import { syntheticSnapshotV2 } from '../classic/fixtures/synthetic-api.js';

type DashboardOptions = { provider?: ClassicApiProvider };
type SourceKind = 'course' | 'announcement' | 'assignment' | 'file' | 'attachment';
type SourceTarget = { readonly kind: SourceKind; readonly id: string; readonly courseId?: string };
type UiAssignment = AssignmentV2 & { manualKey: string; manualAvailable: boolean; manualCompleted?: boolean; localDueAt?: string | null };
type UiSnapshot = SnapshotV2 & {
  readonly assignments: readonly UiAssignment[];
  readonly announcements: readonly UiAnnouncement[];
  readonly account: ClassicAccountContext | null;
  readonly displayWindowDays: 7 | 14 | 30;
  readonly localErrors?: readonly string[];
};
type UiAnnouncement = AnnouncementV2 & { localSeenAt?: string | null };
type LocalDashboardScope = { due: Record<string, string>; seen: Record<string, string> };
type LocalDashboardFile = { version: 1; scopes: Record<string, LocalDashboardScope> };
type CompletionMarks = Readonly<Record<string, boolean>>;

function localDashboardFile(): string { return join(stateHome(), 'dashboard-local-v2.json'); }

function emptyLocalDashboardFile(): LocalDashboardFile { return { version: 1, scopes: {} }; }

async function readLocalDashboardFile(): Promise<LocalDashboardFile> {
  const failed = () => { throw new LmsError('LOCAL_READ_FAILED', '本机 Dashboard 状态文件无法读取，原文件已保留。'); };
  try {
    const parsed = JSON.parse(await readFile(localDashboardFile(), 'utf8')) as Partial<LocalDashboardFile>;
    if (parsed.version !== 1 || !parsed.scopes || typeof parsed.scopes !== 'object' || Array.isArray(parsed.scopes)) return failed();
    const scopes: Record<string, LocalDashboardScope> = {};
    for (const [scope, value] of Object.entries(parsed.scopes)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return failed();
      const scopeValue = value as Partial<LocalDashboardScope>;
      if (!scopeValue.due || typeof scopeValue.due !== 'object' || Array.isArray(scopeValue.due) || !scopeValue.seen || typeof scopeValue.seen !== 'object' || Array.isArray(scopeValue.seen)) return failed();
      const due = scopeValue.due as Record<string, unknown>;
      const seen = scopeValue.seen as Record<string, unknown>;
      if (Object.entries(due).some(([key, item]) => typeof key !== 'string' || typeof item !== 'string' || item.length > 40) || Object.entries(seen).some(([key, item]) => typeof key !== 'string' || typeof item !== 'string' || item.length > 100)) return failed();
      const normalizedDue: Record<string, string> = {};
      const normalizedSeen: Record<string, string> = {};
      for (const [key, item] of Object.entries(due)) normalizedDue[key] = item as string;
      for (const [key, item] of Object.entries(seen)) normalizedSeen[key] = item as string;
      scopes[scope] = { due: normalizedDue, seen: normalizedSeen };
    }
    return { version: 1, scopes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLocalDashboardFile();
    if (error instanceof LmsError) throw error;
    return failed();
  }
}

async function updateLocalDashboardScope(scope: string, update: (value: LocalDashboardScope) => void): Promise<LocalDashboardScope> {
  return locked(async () => {
    const file = await readLocalDashboardFile();
    const value = file.scopes[scope] ?? { due: {}, seen: {} };
    update(value);
    file.scopes[scope] = value;
    try { await atomicWrite(localDashboardFile(), JSON.stringify(file)); }
    catch { throw new LmsError('LOCAL_WRITE_FAILED', '本机 Dashboard 状态无法保存，原文件已保留。'); }
    return structuredClone(value);
  });
}

function localDueValue(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/.test(value)) throw new ClassicApiError('BAD_INPUT', '本机日期必须是 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm。', { scope: 'dashboard.due-override', retryable: false });
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
  if (!match) throw new ClassicApiError('BAD_INPUT', '本机日期无效。', { scope: 'dashboard.due-override', retryable: false });
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  const validCalendar = month >= 1 && month <= 12 && day >= 1 && calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
  const hour = match[4] === undefined ? 0 : Number(match[4]); const minute = match[5] === undefined ? 0 : Number(match[5]);
  if (!validCalendar || hour > 23 || minute > 59) throw new ClassicApiError('BAD_INPUT', '本机日期无效。', { scope: 'dashboard.due-override', retryable: false });
  return value;
}

function profileOrigin(profile: Profile): string {
  if (profile.blackboard !== 'https://bb.cuhk.edu.cn') throw new LmsError('BAD_INPUT', 'CUHK(SZ) 配置的学校网址不匹配。');
  return profile.blackboard;
}

function ipcArgumentSummary(name: string, args: unknown[]): Record<string, unknown> {
  if (name === 'cuhk:load') return { days: args[0] };
  if (name === 'cuhk:login') return { action: args[0] ?? 'begin' };
  if (name === 'cuhk:course') return { courseId: args[0], resource: args[1] };
  if (name === 'cuhk:open-source') return { target: args[0] };
  if (name === 'cuhk:detail') return { assignmentId: args[0] };
  if (name === 'cuhk:due-override' || name === 'cuhk:announcement-seen') return { target: args[0] };
  if (name === 'cuhk:resource-read') return { resourceId: args[0], kind: args[1] };
  if (name === 'cuhk:debug-event') return { event: args[0] };
  return {};
}

function rendererEventDetails(eventName: string, details: unknown): Record<string, unknown> {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const input = details as Record<string, unknown>;
  if (eventName === 'navigate') return typeof input.page === 'string' ? { page: input.page.slice(0, 40) } : {};
  if (eventName === 'filter') {
    const filterKind = input.filterKind === 'course' || input.filterKind === 'status' || input.filterKind === 'query' ? input.filterKind : undefined;
    const taskStatus = input.taskStatus === 'pending' || input.taskStatus === 'completed' || input.taskStatus === 'all' ? input.taskStatus : undefined;
    return {
      ...(typeof input.page === 'string' ? { page: input.page.slice(0, 40) } : {}),
      ...(filterKind ? { filterKind } : {}),
      ...(typeof input.hasQuery === 'boolean' ? { hasQuery: input.hasQuery } : {}),
      ...(typeof input.queryLength === 'number' && Number.isInteger(input.queryLength) ? { queryLength: Math.max(0, Math.min(200, input.queryLength)) } : {}),
      ...(typeof input.hasCourseFilter === 'boolean' ? { hasCourseFilter: input.hasCourseFilter } : {}),
      ...(taskStatus ? { taskStatus } : {}),
    };
  }
  if (eventName === 'renderer.error') return {
    errorType: safeErrorType(input.errorType),
    ...(typeof input.line === 'number' && Number.isInteger(input.line) ? { line: Math.max(0, Math.min(1_000_000, input.line)) } : {}),
    ...(typeof input.column === 'number' && Number.isInteger(input.column) ? { column: Math.max(0, Math.min(1_000_000, input.column)) } : {}),
    ...(typeof input.sourceUrl === 'string' ? { sourceUrl: input.sourceUrl.slice(0, 900) } : {}),
  };
  if (eventName === 'renderer.unhandledrejection') return { errorType: safeErrorType(input.errorType) };
  if (eventName === 'renderer.bridge-ready') return { marker: 'BRIDGE_READY' };
  return {};
}

function withDiagnostics(value: unknown, traceId: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return { ...(value as Record<string, unknown>), diagnostics: debugLog.info(traceId) };
}

const RENDER_ERROR_TYPES = new Set(['Error', 'TypeError', 'SyntaxError', 'ReferenceError', 'RangeError', 'EvalError', 'URIError', 'ImportError', 'ModuleNotFoundError', 'IndentationError', 'TimeoutError']);
const RENDER_GONE_REASONS = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure']);
const CONSOLE_LEVELS = new Set(['info', 'warning', 'error', 'debug']);
const DASHBOARD_SCRIPT_MARKER = 'CUHK_DASHBOARD_SCRIPT_START';
const DASHBOARD_BRIDGE_MARKER = 'CUHK_DASHBOARD_BRIDGE_UNAVAILABLE';
const CONSOLE_ERROR_TYPES = ['SyntaxError', 'ReferenceError', 'TypeError', 'RangeError', 'EvalError', 'URIError', 'ImportError', 'ModuleNotFoundError', 'TimeoutError', 'Error'] as const;

function safeErrorType(value: unknown): string {
  const name = typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string' ? (value as { name: string }).name : '';
  return RENDER_ERROR_TYPES.has(name) ? name : 'Error';
}

function safeGoneReason(value: unknown): string {
  return typeof value === 'string' && RENDER_GONE_REASONS.has(value) ? value : 'unknown';
}

function safeExitCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? Math.max(-32768, Math.min(32767, value)) : undefined;
}

function safeConsoleSource(value: unknown): string {
  if (typeof value !== 'string') return 'other';
  try {
    const protocol = new URL(value).protocol.toLowerCase();
    if (protocol === 'data:') return 'dashboard-inline';
    if (protocol === 'file:') return 'local-file';
    if (protocol === 'http:' || protocol === 'https:') return 'remote-page';
  } catch { /* keep only the fixed fallback category */ }
  return 'other';
}

function safeConsoleLevel(value: unknown): string {
  return typeof value === 'string' && CONSOLE_LEVELS.has(value) ? value : 'error';
}

function safeConsoleLine(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.max(0, Math.min(1_000_000, value)) : 0;
}

function classifyConsoleMessage(value: unknown): { code: string; errorType: string } {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (text.includes('content security policy') || text.includes('content-security-policy') || text.includes('refused to execute inline script')) {
    return { code: 'RENDERER_CSP_ERROR', errorType: 'CSP' };
  }
  for (const errorType of CONSOLE_ERROR_TYPES) {
    if (text.includes(errorType.toLowerCase())) return { code: `RENDERER_${errorType.toUpperCase()}`, errorType };
  }
  return { code: 'RENDERER_CONSOLE_ERROR', errorType: 'generic' };
}

function safeBusinessId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ClassicApiError('BAD_INPUT', '业务资源 ID 无效。', { scope: 'dashboard.business-id', retryable: false });
  }
  return value;
}

function safeCourseId(value: unknown): string {
  if (typeof value !== 'string' || !/^_\d+_\d+$/.test(value)) throw new ClassicApiError('BAD_INPUT', '课程 ID 无效。', { scope: 'dashboard.course-id', retryable: false });
  return value;
}

function safeResourceId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{20,80}$/i.test(value)) throw new ClassicApiError('BAD_INPUT', '资源 ID 无效。', { scope: 'dashboard.resource-id', retryable: false });
  return value;
}

function safeAccount(session: ClassicSessionContract): ClassicAccountContext | null {
  const account = session.account;
  return account ? {
    profileId: account.profileId,
    origin: account.origin,
    userId: account.userId,
    sessionGeneration: account.sessionGeneration,
    timezone: account.timezone,
  } : null;
}

function accountKey(session: ClassicSessionContract): string | null {
  const account = safeAccount(session);
  return account ? `${account.profileId}\0${account.origin}\0${account.userId}\0${account.sessionGeneration}` : null;
}

function localDashboardKey(kind: 'assignment' | 'announcement', courseId: string, id: string): string {
  return `${kind}|${courseId}|${id}`;
}

function publicLoginResult(snapshot: ClassicSessionSnapshot): Record<string, unknown> {
  return { ok: snapshot.state === 'authenticated' && !!snapshot.account, ...snapshot };
}

function uiAssignments(snapshot: SnapshotV2, marks: CompletionMarks, localDue: Readonly<Record<string, string>>, manualAvailable: boolean): UiAssignment[] {
  return snapshot.assignments.map(item => {
    const manualKey = completionKeyV2(item);
    const localDueAt = localDue[localDashboardKey('assignment', item.courseId, item.id)];
    return { ...item, manualKey, manualAvailable, ...(marks[manualKey] === undefined ? {} : { manualCompleted: marks[manualKey] }), ...(localDueAt ? { localDueAt } : {}) };
  });
}

function publicErrorEnvelope(error: unknown): Record<string, unknown> {
  if (error instanceof LmsError) return { error: publicError(error) };
  return { error: publicApiError(error) };
}

function offlineProvider(origin: string, profileId: string): ClassicApiProvider {
  const account: ClassicAccountContext = { profileId, origin: origin as ClassicAccountContext['origin'], userId: 'offline-fixture', sessionGeneration: 1, timezone: 'Asia/Shanghai' };
  let closed = false;
  const session: ClassicSessionContract = {
    state: 'authenticated', account, generation: 1,
    beginLogin: async () => ({ state: 'authenticated', account, generation: 1 }),
    completeLogin: async () => ({ state: 'authenticated', account, generation: 1 }),
    ensureAuthenticated: async () => ({ state: 'authenticated', account, generation: 1 }),
    cookiesFor: async () => [],
    applySetCookie: async () => {},
    close: async () => { closed = true; },
  };
  const fixture = syntheticSnapshotV2();
  const provider = {
    source: 'offline-fixture' as const,
    session,
    snapshot: fixture,
    status: async () => ({ ok: !closed, session: { state: closed ? 'unauthenticated' as const : 'authenticated' as const, account: closed ? null : account, generation: 1 } }),
    beginLogin: async () => ({ state: 'authenticated' as const, account, generation: 1 }),
    completeLogin: async () => ({ state: 'authenticated' as const, account, generation: 1 }),
    load: async () => structuredClone(fixture),
    detail: async (assignment: AssignmentV2) => ({ state: 'unsupported' as const, assignment, content: null, attachments: assignment.attachments, errors: [] }),
    cancel: () => {},
    close: async () => { closed = true; await session.close(); },
  };
  return provider as unknown as ClassicApiProvider;
}

export async function startDashboard(options: DashboardOptions = {}) {
  await app.whenReady();
  await debugLog.initialize();
  await initProfile({ preset: 'cuhksz' });
  const profile = await getProfile('cuhksz');
  const origin = profileOrigin(profile);
  const source: SnapshotV2['source'] = process.env.CUHK_CLASSIC_MODE === 'offline-fixture' ? 'offline-fixture' : 'live';
  debugLog.event('dashboard.start', { source, origin });
  await debugLog.flush();

  let resourceRegistry: ClassicResourceRegistry | undefined;
  const provider = options.provider ?? (source === 'offline-fixture' ? offlineProvider(origin, profile.id) : (() => {
    const session = new ClassicSession({ id: profile.id, blackboard: origin });
    const transport = new ClassicHttpClient(session);
    resourceRegistry = new ClassicResourceRegistry(session, transport);
    return new ClassicApiProvider({ profile: { id: profile.id, blackboard: origin }, session, transport, resourceRegistry, source });
  })());
  resourceRegistry ??= (provider as unknown as { resourceRegistry?: ClassicResourceRegistry }).resourceRegistry;

  const win = new BrowserWindow({ title: 'CUHK(SZ) · Blackboard Classic', width: 1240, height: 850, minWidth: 800, minHeight: 600, show: false,
    backgroundColor: '#f6f4f9', webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', details => {
    const sourceType = safeConsoleSource(details.sourceId);
    const level = safeConsoleLevel(details.level);
    const lineNumber = safeConsoleLine(details.lineNumber);
    if (details.message === DASHBOARD_SCRIPT_MARKER) {
      debugLog.event('dashboard.renderer.marker', { code: 'DASHBOARD_SCRIPT_START', marker: 'SCRIPT_START', level, lineNumber, sourceType });
    } else if (details.message === DASHBOARD_BRIDGE_MARKER) {
      debugLog.event('dashboard.renderer.marker', { code: 'DASHBOARD_BRIDGE_UNAVAILABLE', marker: 'BRIDGE_UNAVAILABLE', level, lineNumber, sourceType });
    } else if (level === 'error') {
      const classification = classifyConsoleMessage(details.message);
      debugLog.event('dashboard.renderer.console-error', { ...classification, level, lineNumber, sourceType });
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('preload-error', (_event, _preloadPath, error) => debugLog.event('dashboard.preload-error', { errorType: safeErrorType(error) }));
  win.webContents.on('render-process-gone', (_event, details) => debugLog.event('dashboard.render-process-gone', { reason: safeGoneReason(details?.reason), exitCode: safeExitCode(details?.exitCode) }));
  win.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => debugLog.event('dashboard.did-fail-load', { errorCode, targetUrl: validatedURL, isMainFrame: Boolean(isMainFrame) }));

  const sourceWindows = new Set<BrowserWindow>();
  let lastSnapshot: SnapshotV2 | undefined;
  let visibleKeys = new Set<string>();
  let manualMarksAvailable = false;
  let activeCompletionScope: CompletionScopeV2 | undefined;
  let loading: Promise<unknown> | undefined;
  let loadController: AbortController | undefined;
  let detailController: AbortController | undefined;
  let migration: { plan: CompletionMigrationPlan; legacy: LegacyCompletionScope; scope: CompletionScopeV2; accountKey: string } | undefined;
  const completionStore = new CompletionStoreV2();
  const legacyCompletionStore = new LegacyCompletionStore();
  const legacySnapshotCache = new ClassicSnapshotCache();
  const resourceControllers = new Set<AbortController>();
  const session = provider.session;

  const abortActiveOperations = (reason: ClassicApiError) => {
    loadController?.abort(reason);
    detailController?.abort(reason);
    for (const controller of resourceControllers) controller.abort(reason);
    provider.cancel();
  };

  const clearAccountBoundState = () => {
    lastSnapshot = undefined;
    visibleKeys = new Set<string>();
    manualMarksAvailable = false;
    activeCompletionScope = undefined;
    migration = undefined;
  };
  let lastAccountKey = accountKey(session);
  const refreshAccountBoundary = () => {
    const next = accountKey(session);
    if (next !== lastAccountKey) {
      abortActiveOperations(new ClassicApiError('SESSION_EXPIRED', '登录会话已变化，旧操作已取消。', { scope: 'dashboard.account.changed', retryable: false }));
      clearAccountBoundState();
      for (const sourceWindow of sourceWindows) if (!sourceWindow.isDestroyed()) sourceWindow.close();
      sourceWindows.clear();
      lastAccountKey = next;
      debugLog.event('dashboard.account.changed', { hasAccount: Boolean(next) });
    }
    return next;
  };
  const completionScopeForAccount = (): CompletionScopeV2 => {
    const account = safeAccount(session);
    if (!account) throw new ClassicApiError('AUTH_REQUIRED', '请先完成 Blackboard 登录，再读取本机完成标记。', { scope: 'dashboard.completion', retryable: false });
    const scope: CompletionScopeV2 = { profileId: account.profileId, origin: account.origin, userId: account.userId, source };
    activeCompletionScope = scope;
    return scope;
  };

  const localScopeForAccount = (): string => {
    const account = safeAccount(session);
    if (!account) throw new ClassicApiError('AUTH_REQUIRED', '请先完成 Blackboard 登录，再读取本机日期和公告标记。', { scope: 'dashboard.local-state', retryable: false });
    return completionScope(account.profileId, `${account.origin}|dashboard-local-v2|${source}`, account.userId);
  };

  const localForAccount = async (): Promise<LocalDashboardScope> => {
    const scope = localScopeForAccount();
    const file = await readLocalDashboardFile();
    return file.scopes[scope] ?? { due: {}, seen: {} };
  };

  const decorate = async (snapshot: SnapshotV2, displayWindowDays: 7 | 14 | 30): Promise<UiSnapshot> => {
    const scope = completionScopeForAccount();
    let marks: CompletionMarks = {};
    let manualAvailable = true;
    let local: LocalDashboardScope = { due: {}, seen: {} };
    const localErrors: string[] = [];
    try {
      const file = await completionStore.load(scope);
      marks = Object.fromEntries(Object.entries(file.marks).map(([key, mark]) => [key, mark.completed]));
    } catch {
      manualAvailable = false;
      localErrors.push('本机完成标记读取失败，已禁用本机勾选；远程数据仍可查看。');
    }
    try { local = await localForAccount(); }
    catch { localErrors.push('本机日期或公告标记读取失败，原文件已保留。'); }
    const assignments = uiAssignments(snapshot, marks, local.due, manualAvailable);
    manualMarksAvailable = manualAvailable;
    const announcements: UiAnnouncement[] = snapshot.announcements.map(item => ({ ...item, localSeenAt: local.seen[localDashboardKey('announcement', item.courseId, item.id)] ?? item.localSeenAt }));
    visibleKeys = new Set(assignments.map(item => item.manualKey));
    return { ...snapshot, assignments, announcements, account: safeAccount(session), displayWindowDays, ...(localErrors.length ? { localErrors } : {}) };
  };

  const sourceUrlFor = (snapshot: SnapshotV2, target: SourceTarget): string => {
    const id = safeBusinessId(target.id);
    const courseId = target.kind === 'course' ? safeCourseId(id) : safeCourseId(target.courseId);
    let value: string | null | undefined;
    if (target.kind === 'course') value = snapshot.courses.find(item => item.id === id)?.url;
    else if (target.kind === 'announcement') value = snapshot.announcements.find(item => item.courseId === courseId && item.id === id)?.url;
    else if (target.kind === 'assignment') value = snapshot.assignments.find(item => item.courseId === courseId && item.id === id)?.url;
    else if (target.kind === 'file') value = snapshot.files.find(item => item.courseId === courseId && item.id === id)?.url;
    else {
      for (const assignment of snapshot.assignments.filter(item => item.courseId === courseId)) {
        const attachment = assignment.attachments.find(item => item.id === id);
        if (attachment) { value = attachment.url; break; }
      }
      if (!value) for (const file of snapshot.files.filter(item => item.courseId === courseId)) {
        const attachment = file.attachments.find(item => item.id === id);
        if (attachment) { value = attachment.url; break; }
      }
    }
    if (!value) throw new ClassicApiError('NOT_FOUND', '该业务资源没有可验证的 Blackboard 来源页面。', { scope: `dashboard.source:${target.kind}`, retryable: false });
    return requireClassicUrl(value);
  };

  const openSourceWindow = async (target: SourceTarget): Promise<Record<string, unknown>> => {
    refreshAccountBoundary();
    const snapshot = lastSnapshot;
    if (!snapshot) throw new ClassicApiError('NOT_FOUND', '请先刷新课程数据，再打开来源页面。', { scope: 'dashboard.source', retryable: false });
    const sourceAccountKey = accountKey(session);
    if (!sourceAccountKey) throw new ClassicApiError('AUTH_REQUIRED', '请先完成当前 Blackboard 账号登录。', { scope: 'dashboard.source', retryable: false });
    const url = sourceUrlFor(snapshot, target);
    const sessionWithWindow = session as ClassicSessionContract & { electronSession?: ElectronSession };
    const partitionSession = sessionWithWindow.electronSession;
    if (!partitionSession) throw new ClassicApiError('BAD_INPUT', '当前 Classic 会话未提供受保护的学校窗口。', { scope: 'dashboard.source', retryable: false });
    const sourceWindow = new BrowserWindow({ title: 'Blackboard Classic · 来源页面', width: 1180, height: 820, show: false,
      webPreferences: { session: partitionSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    const sourceTraceId = currentTraceId() ?? createTraceId();
    const allowedNavigation = (candidate: string): boolean => {
      try {
        const parsed = new URL(candidate);
        return accountKey(session) === sourceAccountKey && parsed.protocol === 'https:' && parsed.origin === origin && !parsed.username && !parsed.password && !parsed.port;
      } catch { return false; }
    };
    const sourceWindowOptions = { session: partitionSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } as const;
    const hardenSourceWindow = (browserWindow: BrowserWindow): void => {
      if (sourceWindows.has(browserWindow)) return;
      if (browserWindow.webContents.session !== partitionSession) { if (!browserWindow.isDestroyed()) browserWindow.destroy(); return; }
      sourceWindows.add(browserWindow);
      browserWindow.webContents.setWindowOpenHandler(({ url: childUrl }) => allowedNavigation(childUrl)
        ? { action: 'allow', overrideBrowserWindowOptions: { webPreferences: sourceWindowOptions } }
        : { action: 'deny' });
      browserWindow.webContents.on('will-navigate', (event, candidate) => {
        if (!allowedNavigation(candidate)) event.preventDefault();
      });
      browserWindow.webContents.on('will-redirect', (event, candidate) => {
        if (!allowedNavigation(candidate)) event.preventDefault();
      });
      browserWindow.webContents.on('did-create-window', child => hardenSourceWindow(child));
      browserWindow.webContents.on('did-navigate', (_event, landingUrl) => runWithTrace(sourceTraceId, () => debugLog.event('dashboard.source.landed', { targetUrl: url, landingUrl, kind: target.kind })));
      browserWindow.on('closed', () => sourceWindows.delete(browserWindow));
    };
    hardenSourceWindow(sourceWindow);
    debugLog.event('dashboard.source.open', { targetUrl: url, kind: target.kind });
    try {
      await sourceWindow.loadURL(url);
      if (accountKey(session) !== sourceAccountKey) throw new ClassicApiError('SESSION_EXPIRED', '登录会话已变化，来源窗口未继续打开。', { scope: 'dashboard.source.generation', retryable: false });
    }
    catch (error) { sourceWindows.delete(sourceWindow); if (!sourceWindow.isDestroyed()) sourceWindow.destroy(); refreshAccountBoundary(); throw error; }
    sourceWindow.show(); sourceWindow.focus();
    return { ok: true, kind: target.kind };
  };

  const handle = (name: string, action: (...args: any[]) => Promise<unknown>) => {
    ipcMain.handle(name, async (event, ...args) => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Unknown sender');
      const traceId = createTraceId();
      return runWithTrace(traceId, async () => {
        const started = Date.now();
        debugLog.event('ipc.start', { channel: name, ...ipcArgumentSummary(name, args) });
        await debugLog.flush();
        try {
          const result = await action(...args);
          debugLog.event('ipc.done', { channel: name, elapsedMs: Date.now() - started });
          await debugLog.flush();
          return withDiagnostics(result, traceId);
        } catch (error) {
          const safe = publicErrorEnvelope(error);
          debugLog.error('ipc.error', error, { channel: name, elapsedMs: Date.now() - started });
          await debugLog.flush();
          return withDiagnostics(safe, traceId);
        }
      });
    });
  };

  handle('cuhk:status', async () => {
    const result = await provider.status(new AbortController().signal, currentTraceId());
    refreshAccountBoundary();
    return { ok: result.ok, state: result.session.state, session: result.session, account: safeAccount(session), ...(result.error ? { error: result.error } : {}) };
  });
  handle('cuhk:load', async (days: unknown) => {
    if (days !== 7 && days !== 14 && days !== 30) throw new LmsError('BAD_INPUT', '请选择 7、14 或 30 天。');
    if (loading) return loading;
    const controller = new AbortController();
    loadController = controller;
    const startGeneration = session.generation;
    const startAccountKey = lastAccountKey;
    loading = (async () => {
      const loaded = await provider.load(controller.signal, currentTraceId());
      const loadedAccountKey = accountKey(session);
      if (session.generation !== startGeneration || (startAccountKey !== null && loadedAccountKey !== startAccountKey)) throw new ClassicApiError('SESSION_EXPIRED', '登录会话在同步期间发生变化，本次结果已丢弃。', { scope: 'dashboard.load.generation', retryable: false });
      lastAccountKey = loadedAccountKey;
      lastSnapshot = loaded;
      const decorated = await decorate(loaded, days as 7 | 14 | 30);
      if (session.generation !== startGeneration || accountKey(session) !== loadedAccountKey) throw new ClassicApiError('SESSION_EXPIRED', '登录会话在整理本机状态期间发生变化，本次结果已丢弃。', { scope: 'dashboard.load.decorate', retryable: false });
      return decorated;
    })().catch(error => { refreshAccountBoundary(); throw error; });
    try { return await loading; }
    finally { if (loadController === controller) loadController = undefined; loading = undefined; }
  });
  handle('cuhk:cancel', async () => {
    const reason = new ClassicApiError('TIMEOUT', 'Classic 同步已取消。', { scope: 'dashboard.cancel', retryable: false });
    abortActiveOperations(reason);
    return { ok: true };
  });
  handle('cuhk:login', async (action: unknown = 'begin') => {
    if (action !== 'begin' && action !== 'complete') throw new LmsError('BAD_INPUT', '登录动作无效。');
    if (action === 'begin') {
      abortActiveOperations(new ClassicApiError('SESSION_EXPIRED', '重新授权开始，当前操作已取消。', { scope: 'dashboard.login.begin', retryable: false }));
      for (const sourceWindow of sourceWindows) if (!sourceWindow.isDestroyed()) sourceWindow.close();
      sourceWindows.clear();
      clearAccountBoundState();
    }
    refreshAccountBoundary();
    try {
      const snapshot = action === 'begin' ? await provider.beginLogin(undefined, currentTraceId()) : await provider.completeLogin(undefined, currentTraceId());
      refreshAccountBoundary();
      return publicLoginResult(snapshot);
    } catch (error) {
      refreshAccountBoundary();
      return { ok: false, state: session.state, account: safeAccount(session), error: publicApiError(error) };
    }
  });
  handle('cuhk:close', async () => {
    abortActiveOperations(new ClassicApiError('TIMEOUT', 'Dashboard 正在关闭，当前操作已取消。', { scope: 'dashboard.close', retryable: false }));
    for (const sourceWindow of sourceWindows) if (!sourceWindow.isDestroyed()) sourceWindow.close();
    sourceWindows.clear();
    await provider.close();
    return { ok: true };
  });
  handle('cuhk:complete', async (key: unknown, value: unknown) => {
    refreshAccountBoundary();
    if (!manualMarksAvailable) throw new ClassicApiError('CACHE_FALLBACK', '本机完成标记不可用，当前只保留远程数据。', { scope: 'dashboard.completion', stale: true, retryable: true });
    if (loading || typeof key !== 'string' || !visibleKeys.has(key) || (value !== null && typeof value !== 'boolean')) throw new LmsError('BAD_INPUT', '请刷新后再设置完成标记。');
    const scope = activeCompletionScope ?? completionScopeForAccount();
    const startAccountKey = accountKey(session);
    try { await completionStore.set(scope, key, value); }
    catch (error) { manualMarksAvailable = false; throw error; }
    if (accountKey(session) !== startAccountKey) throw new ClassicApiError('SESSION_EXPIRED', '登录会话在保存本机完成标记期间发生变化。', { scope: 'dashboard.completion.generation', retryable: false });
    return { ok: true, key, completed: value };
  });
  handle('cuhk:due-override', async (assignmentId: unknown, value: unknown) => {
    refreshAccountBoundary();
    if (!assignmentId || typeof assignmentId !== 'object' || Array.isArray(assignmentId)) throw new LmsError('BAD_INPUT', '作业目标无效。');
    const target = assignmentId as Record<string, unknown>;
    const courseId = safeCourseId(target.courseId);
    const id = safeBusinessId(target.id);
    if (!lastSnapshot?.assignments.some(item => item.courseId === courseId && item.id === id)) throw new ClassicApiError('NOT_FOUND', '作业不在当前快照中。', { scope: 'dashboard.due-override', retryable: false });
    const scope = localScopeForAccount();
    const parsed = localDueValue(value);
    const key = localDashboardKey('assignment', courseId, id);
    const startAccountKey = accountKey(session);
    await updateLocalDashboardScope(scope, local => { if (parsed) local.due[key] = parsed; else delete local.due[key]; });
    if (accountKey(session) !== startAccountKey) throw new ClassicApiError('SESSION_EXPIRED', '登录会话在保存本机日期期间发生变化。', { scope: 'dashboard.due-override.generation', retryable: false });
    return { ok: true, courseId, assignmentId: id, localDueAt: parsed };
  });
  handle('cuhk:announcement-seen', async (announcementId: unknown, value: unknown) => {
    refreshAccountBoundary();
    if (!announcementId || typeof announcementId !== 'object' || Array.isArray(announcementId)) throw new LmsError('BAD_INPUT', '公告目标无效。');
    const target = announcementId as Record<string, unknown>;
    const courseId = safeCourseId(target.courseId);
    const id = safeBusinessId(target.id);
    if (typeof value !== 'boolean' || !lastSnapshot?.announcements.some(item => item.courseId === courseId && item.id === id)) throw new ClassicApiError('BAD_INPUT', '公告本机已读参数无效。', { scope: 'dashboard.announcement-seen', retryable: false });
    const scope = localScopeForAccount();
    const key = localDashboardKey('announcement', courseId, id);
    const startAccountKey = accountKey(session);
    await updateLocalDashboardScope(scope, local => { if (value) local.seen[key] = new Date().toISOString(); else delete local.seen[key]; });
    if (accountKey(session) !== startAccountKey) throw new ClassicApiError('SESSION_EXPIRED', '登录会话在保存公告本机标记期间发生变化。', { scope: 'dashboard.announcement-seen.generation', retryable: false });
    return { ok: true, courseId, announcementId: id, localSeen: value };
  });
  handle('cuhk:detail', async (assignmentId: unknown) => {
    refreshAccountBoundary();
    if (!assignmentId || typeof assignmentId !== 'object' || Array.isArray(assignmentId)) throw new LmsError('BAD_INPUT', '作业目标无效。');
    const target = assignmentId as Record<string, unknown>;
    const courseId = safeCourseId(target.courseId);
    const id = safeBusinessId(target.id);
    const assignment = lastSnapshot?.assignments.find(item => item.courseId === courseId && item.id === id);
    if (!assignment) throw new ClassicApiError('NOT_FOUND', '作业不在当前快照中。', { scope: 'dashboard.detail', retryable: false });
    const snapshotAtStart = lastSnapshot;
    const accountAtStart = accountKey(session);
    const controller = new AbortController();
    detailController = controller;
    try {
      const result = await provider.detail(assignment, controller.signal, currentTraceId());
      if (accountKey(session) !== accountAtStart || lastSnapshot !== snapshotAtStart) throw new ClassicApiError('SESSION_EXPIRED', '当前课程数据已变化，详情结果已丢弃。', { scope: 'dashboard.detail.stale', retryable: false });
      if (lastSnapshot && result.assignment.courseId === assignment.courseId && result.assignment.id === assignment.id) {
        lastSnapshot = { ...lastSnapshot, assignments: lastSnapshot.assignments.map(item => item.courseId === result.assignment.courseId && item.id === result.assignment.id ? result.assignment : item) };
      }
      return { ok: true, ...result, assignment: { ...result.assignment, manualKey: completionKeyV2(result.assignment), manualAvailable: manualMarksAvailable } };
    } finally {
      if (detailController === controller) detailController = undefined;
      refreshAccountBoundary();
    }
  });
  handle('cuhk:resource-read', async (resourceId: unknown, kind: unknown = 'image') => {
    const id = safeResourceId(resourceId);
    if (kind !== 'image') throw new ClassicApiError('BAD_INPUT', '当前 Dashboard 只允许读取已注册图片资源。', { scope: 'dashboard.resource-read', retryable: false });
    if (!resourceRegistry) throw new ClassicApiError('NOT_FOUND', '当前会话未提供图片资源读取器。', { scope: 'dashboard.resource-read', retryable: false });
    const controller = new AbortController();
    const startAccountKey = accountKey(session);
    resourceControllers.add(controller);
    try {
      const result = await resourceRegistry.read(id, { method: 'GET', expectedKind: 'image', signal: controller.signal, traceId: currentTraceId() });
      if (accountKey(session) !== startAccountKey) throw new ClassicApiError('SESSION_EXPIRED', '登录会话在读取图片期间发生变化。', { scope: 'dashboard.resource-read.generation', retryable: false });
      if (!result.body || !result.mimeType.startsWith('image/')) throw new ClassicApiError('RESOURCE_FAILED', '图片资源类型不受支持。', { scope: 'dashboard.resource-read', retryable: false });
      return { ok: true, resourceId: id, mimeType: result.mimeType, dataUrl: `data:${result.mimeType};base64,${Buffer.from(result.body).toString('base64')}` };
    } finally {
      resourceControllers.delete(controller);
      refreshAccountBoundary();
    }
  });
  handle('cuhk:open-source', async (target: unknown) => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) throw new LmsError('BAD_INPUT', '来源目标无效。');
    const value = target as Record<string, unknown>;
    const kind = String(value.kind);
    if (!['course', 'announcement', 'assignment', 'file', 'attachment'].includes(kind)) throw new LmsError('BAD_INPUT', '来源类型无效。');
    const id = safeBusinessId(value.id);
    return openSourceWindow({ kind: kind as SourceKind, id, ...(kind === 'course' ? {} : { courseId: safeCourseId(value.courseId) }) });
  });
  handle('cuhk:course', async (id: unknown, resource: unknown) => {
    refreshAccountBoundary();
    if (typeof id !== 'string' || !/^_\d+_\d+$/.test(id) || (resource !== 'content' && resource !== 'files')) throw new LmsError('BAD_INPUT', '课程或查询类型无效。');
    const snapshot = lastSnapshot;
    if (!snapshot) throw new ClassicApiError('NOT_FOUND', '请先刷新课程数据。', { scope: 'dashboard.course', retryable: false });
    return { ok: true, course: snapshot.courses.find(item => item.id === id) ?? null, files: resource === 'files' ? snapshot.files.filter(file => file.courseId === id) : [] };
  });

  handle('cuhk:migration-preview', async () => {
    refreshAccountBoundary();
    const snapshot = lastSnapshot;
    const account = safeAccount(session);
    if (!snapshot || !account) throw new ClassicApiError('AUTH_REQUIRED', '请先读取当前账号后再预览完成标记迁移。', { scope: 'dashboard.migration', retryable: false });
    const startAccountKey = accountKey(session);
    const modeScope = source === 'offline-fixture' ? 'offline-fixture' : 'local-account';
    const legacyScope = completionScope(profile.id, `${origin}|${modeScope}`, modeScope);
    let marks: Readonly<Record<string, boolean>>;
    try { marks = await legacyCompletionStore.load(legacyScope); }
    catch { throw new ClassicApiError('CACHE_FALLBACK', '旧完成标记无法读取，原文件未覆盖。', { scope: 'dashboard.migration.read', stale: true, retryable: false }); }
    if (accountKey(session) !== startAccountKey) throw new ClassicApiError('SESSION_EXPIRED', '登录会话在迁移预览期间发生变化。', { scope: 'dashboard.migration.generation', retryable: false });
    const legacySnapshotScope = `${profile.id}|${origin}|${source}`;
    const taskMetadata: Record<string, { courseId: string; id: string; title: string; dueAt: string | null; dueDateOnly: string | null; url: string | null }> = {};
    try {
      const oldSnapshot = await legacySnapshotCache.read(legacySnapshotScope);
      if (oldSnapshot) {
        for (const task of oldSnapshot.assignments) {
          const metadata = { courseId: task.courseId, id: task.id, title: task.title, dueAt: task.dueAt, dueDateOnly: task.dueDateOnly, url: task.url };
          taskMetadata[legacyCompletionKey(metadata)] = metadata;
        }
      }
    } catch {
      throw new ClassicApiError('CACHE_FALLBACK', '旧 Classic 快照无法读取，原文件已保留。', { scope: 'dashboard.migration.snapshot-read', stale: true, retryable: false });
    }
    if (accountKey(session) !== startAccountKey) throw new ClassicApiError('SESSION_EXPIRED', '登录会话在迁移预览期间发生变化。', { scope: 'dashboard.migration.generation', retryable: false });
    const legacy: LegacyCompletionScope = { scopeKey: legacyScope, marks, boundUserId: null, taskMetadata };
    const current = completionScopeForAccount();
    const plan = planCompletionMigration({ legacy, current, tasks: snapshot.assignments });
    migration = { plan, legacy, scope: current, accountKey: accountKey(session)! };
    return { ok: true, plan };
  });
  handle('cuhk:migration-confirm', async (migrationId: unknown, confirmAccount: unknown, selections: unknown = []) => {
    refreshAccountBoundary();
    const account = safeAccount(session);
    if (!account || !migration || migration.accountKey !== accountKey(session) || migration.plan.migrationId !== migrationId) throw new ClassicApiError('BAD_INPUT', '迁移预览已失效，请重新生成预览。', { scope: 'dashboard.migration', retryable: false });
    if (typeof confirmAccount !== 'boolean') throw new ClassicApiError('BAD_INPUT', '请明确确认旧标记属于当前 Blackboard 账号。', { scope: 'dashboard.migration', retryable: false });
    if (!Array.isArray(selections) || selections.length > 500 || selections.some(item => !item || typeof item !== 'object' || Array.isArray(item) || typeof (item as Record<string, unknown>).legacyKey !== 'string' || typeof (item as Record<string, unknown>).newKey !== 'string')) throw new ClassicApiError('BAD_INPUT', '迁移选择无效。', { scope: 'dashboard.migration', retryable: false });
    const selected = (selections as Array<Record<string, unknown>>).map(item => ({ legacyKey: String(item.legacyKey).slice(0, 500), newKey: String(item.newKey).slice(0, 100) }));
    const startAccountKey = accountKey(session);
    const result = await completionStore.migrate(migration.scope, {
      plan: migration.plan,
      legacy: migration.legacy,
      confirmAccount,
      confirmedUserId: confirmAccount ? account.userId : undefined,
      selections: selected,
    }, { legacySourcePath: join(stateHome(), 'dashboard-completion.json') });
    if (accountKey(session) !== startAccountKey) throw new ClassicApiError('SESSION_EXPIRED', '登录会话在迁移写入期间发生变化，结果已隔离在原账号 scope。', { scope: 'dashboard.migration.generation', retryable: false });
    migration = undefined;
    return { ok: true, ...result };
  });
  handle('cuhk:debug-event', async (eventName: unknown, details: unknown = {}) => {
    if (typeof eventName !== 'string' || !/^[a-z][a-z0-9._-]{0,80}$/i.test(eventName)) throw new LmsError('BAD_INPUT', '诊断事件名称无效。');
    debugLog.event('renderer.event', { eventName, ...rendererEventDetails(eventName, details) });
    return { ok: true };
  });
  handle('cuhk:debug-info', async () => debugLog.info());
  handle('cuhk:open-diagnostics', async () => {
    const directory = debugLogDirectory();
    const failure = await shell.openPath(directory);
    if (failure) {
      debugLog.event('diagnostics.open.error', { directory, errorCode: 'LOG_DIR_OPEN_FAILED' });
      return { ok: false, directory, path: debugLog.info().path, error: '无法打开本机诊断日志目录。' };
    }
    debugLog.event('diagnostics.open.done', { directory });
    return { ok: true, directory, path: debugLog.info().path };
  });
  handle('cuhk:copy-diagnostics', async () => {
    const path = debugLog.info().path;
    try {
      clipboard.writeText(path);
      debugLog.event('diagnostics.copy.done');
      return { ok: true, path };
    } catch {
      debugLog.event('diagnostics.copy.error', { errorCode: 'LOG_PATH_COPY_FAILED' });
      return { ok: false, path, error: '无法复制本机诊断日志位置。' };
    }
  });

  let closing = false;
  win.on('close', event => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    for (const sourceWindow of sourceWindows) if (!sourceWindow.isDestroyed()) sourceWindow.close();
    void provider.close().finally(async () => { await debugLog.flush(); win.destroy(); });
  });
  win.on('closed', () => {
    if (!closing) { closing = true; void provider.close().finally(() => { void debugLog.flush(); }); }
    app.quit();
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(classicDashboardHTML()));
  win.show(); win.focus();
  debugLog.event('dashboard.ready', { source });
}
