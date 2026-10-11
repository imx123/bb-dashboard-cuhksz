import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { getProfile, initProfile, type Profile } from '../config.js';
import { LmsError, publicError } from '../errors.js';
import { CompletionStore, completionKey, completionScope } from './completion-store.js';
import { classicDashboardHTML } from './classic-ui.js';
import { classicUserDataDir } from '../classic/mcp-client.js';
import { ClassicProvider } from '../classic/provider.js';
import { publicClassicError } from '../classic/errors.js';
import { requireClassicUrl } from '../classic/url-policy.js';
import { createTraceId, debugLog, debugLogDirectory, runWithTrace } from '../debug-log.js';
import type { Snapshot } from '../classic/schema.js';

type DashboardOptions = { provider?: ClassicProvider };

function profileOrigin(profile: Profile): string {
  if (profile.blackboard !== 'https://bb.cuhk.edu.cn') throw new LmsError('BAD_INPUT', 'CUHK(SZ) 配置的学校网址不匹配。');
  return profile.blackboard;
}

function ipcArgumentSummary(name: string, args: unknown[]): Record<string, unknown> {
  if (name === 'cuhk:load') return { days: args[0] };
  if (name === 'cuhk:login') return { action: args[0] ?? 'begin' };
  if (name === 'cuhk:course') return { courseId: args[0], resource: args[1] };
  if (name === 'cuhk:open') return { targetUrl: args[0] };
  if (name === 'cuhk:debug-event') return { event: args[0] };
  return {};
}

function rendererEventDetails(eventName: string, details: unknown): Record<string, unknown> {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const input = details as Record<string, unknown>;
  if (eventName === 'navigate') return typeof input.page === 'string' ? { page: input.page.slice(0, 40) } : {};
  if (eventName === 'filter') return {
    ...(typeof input.page === 'string' ? { page: input.page.slice(0, 40) } : {}),
    ...(typeof input.hasQuery === 'boolean' ? { hasQuery: input.hasQuery } : {}),
    ...(typeof input.queryLength === 'number' && Number.isInteger(input.queryLength) ? { queryLength: Math.max(0, Math.min(200, input.queryLength)) } : {}),
  };
  if (eventName === 'renderer.error') return {
    errorType: safeErrorType(input.errorType),
    ...(typeof input.line === 'number' && Number.isInteger(input.line) ? { line: Math.max(0, Math.min(1_000_000, input.line)) } : {}),
    ...(typeof input.column === 'number' && Number.isInteger(input.column) ? { column: Math.max(0, Math.min(1_000_000, input.column)) } : {}),
    ...(typeof input.sourceUrl === 'string' ? { sourceUrl: input.sourceUrl.slice(0, 900) } : {}),
  };
  if (eventName === 'renderer.unhandledrejection') return { errorType: safeErrorType(input.errorType) };
  return {};
}

function withDiagnostics(value: unknown, traceId: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return { ...(value as Record<string, unknown>), diagnostics: debugLog.info(traceId) };
}

const RENDER_ERROR_TYPES = new Set(['Error', 'TypeError', 'SyntaxError', 'ReferenceError', 'RangeError', 'EvalError', 'URIError', 'ImportError', 'ModuleNotFoundError', 'IndentationError', 'TimeoutError']);
const RENDER_GONE_REASONS = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure']);

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

export async function startDashboard(options: DashboardOptions = {}) {
  await app.whenReady();
  await debugLog.initialize();
  await initProfile({ preset: 'cuhksz' });
  const profile = await getProfile('cuhksz');
  const origin = profileOrigin(profile);
  const source = process.env.CUHK_CLASSIC_MODE === 'offline-fixture' ? 'offline-fixture' : 'live';
  const scope = `${profile.id}|${origin}|${source}`;
  debugLog.event('dashboard.start', { source, origin });
  await debugLog.flush();
  const provider = options.provider ?? new ClassicProvider({ scope, source, userDataDir: source === 'live' ? classicUserDataDir(scope) : undefined });
  const win = new BrowserWindow({ title: 'CUHK(SZ) · Blackboard Classic', width: 1240, height: 850, minWidth: 800, minHeight: 600, show: false,
    backgroundColor: '#f6f4f9', webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('preload-error', (_event, _preloadPath, error) => {
    debugLog.event('dashboard.preload-error', { errorType: safeErrorType(error) });
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    debugLog.event('dashboard.render-process-gone', { reason: safeGoneReason(details?.reason), exitCode: safeExitCode(details?.exitCode) });
  });
  win.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
    debugLog.event('dashboard.did-fail-load', { errorCode, targetUrl: validatedURL, isMainFrame: Boolean(isMainFrame) });
  });
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
          const safe = error instanceof LmsError ? publicError(error) : publicClassicError(error);
          debugLog.error('ipc.error', error, { channel: name, elapsedMs: Date.now() - started, errorCode: safe.code });
          await debugLog.flush();
          return withDiagnostics({ error: safe }, traceId);
        }
      });
    });
  };
  const completionStore = new CompletionStore();
  const modeScope = source === 'offline-fixture' ? 'offline-fixture' : 'local-account';
  const manualScope = completionScope(profile.id, `${origin}|${modeScope}`, modeScope);
  let visibleKeys = new Set<string>();
  let loading: Promise<unknown> | undefined;
  handle('cuhk:load', async (days: unknown) => {
    if (days !== 7 && days !== 14 && days !== 30) throw new LmsError('BAD_INPUT', '请选择 7、14 或 30 天。');
    if (loading) return loading;
    loading = (async () => {
      const loaded = await provider.load(days);
      type UiAssignment = Snapshot['assignments'][number] & { manualKey: string; manualAvailable: boolean; manualCompleted?: boolean };
      const assignments: UiAssignment[] = loaded.assignments.map(item => ({ ...item, manualKey: completionKey(item), manualAvailable: true }));
      const data = { ...loaded, assignments };
      visibleKeys = new Set(data.assignments.map(item => item.manualKey));
      let marks: Record<string, boolean> = {};
      try { marks = await completionStore.load(manualScope); }
      catch { data.errors = [...data.errors, { scope: 'manual-completion', code: 'LOCAL_READ_FAILED', message: '本机完成标记无法读取，暂时不能手动勾选。' }]; }
      data.assignments = data.assignments.map(item => ({ ...item, manualCompleted: marks[item.manualKey] }));
      return data;
    })();
    try { return await loading; } finally { loading = undefined; }
  });
  handle('cuhk:complete', async (key: unknown, value: unknown) => {
    if (loading || typeof key !== 'string' || !visibleKeys.has(key) || (value !== null && typeof value !== 'boolean')) throw new LmsError('BAD_INPUT', '请刷新后再设置完成标记。');
    await completionStore.set(manualScope, key, value);
    return { ok: true };
  });
  handle('cuhk:login', async (action: unknown = 'begin') => {
    if (action !== 'begin' && action !== 'complete') throw new LmsError('BAD_INPUT', '登录动作无效。');
    return provider.login(action);
  });
  handle('cuhk:course', async (id: unknown, resource: unknown) => {
    if (typeof id !== 'string' || !/^_\d+_\d+$/.test(id) || (resource !== 'content' && resource !== 'files')) throw new LmsError('BAD_INPUT', '课程或查询类型无效。');
    const snapshot = provider.snapshot;
    if (!snapshot) throw new LmsError('NOT_FOUND', '请先刷新课程数据。');
    if (resource === 'files') return { ok: true, files: snapshot.files.filter(file => file.courseId === id) };
    return { ok: true, text: 'Classic 课程内容请通过 Blackboard 原页面查看。' };
  });
  handle('cuhk:resource', async () => { throw new LmsError('BAD_INPUT', '该版本不提供外部工具链接。'); });
  handle('cuhk:open', async (value: unknown) => {
    const url = requireClassicUrl(value);
    await shell.openExternal(url);
    return { ok: true };
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
