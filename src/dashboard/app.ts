import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { getProfile, initProfile, type Profile } from '../config.js';
import { LmsError, publicError } from '../errors.js';
import { CompletionStore, completionKey, completionScope } from './completion-store.js';
import { classicDashboardHTML } from './classic-ui.js';
import { classicUserDataDir } from '../classic/mcp-client.js';
import { ClassicProvider } from '../classic/provider.js';
import { publicClassicError } from '../classic/errors.js';
import { requireClassicUrl } from '../classic/url-policy.js';
import type { Snapshot } from '../classic/schema.js';

type DashboardOptions = { provider?: ClassicProvider };

function profileOrigin(profile: Profile): string {
  if (profile.blackboard !== 'https://bb.cuhk.edu.cn') throw new LmsError('BAD_INPUT', 'CUHK(SZ) 配置的学校网址不匹配。');
  return profile.blackboard;
}

export async function startDashboard(options: DashboardOptions = {}) {
  await app.whenReady();
  await initProfile({ preset: 'cuhksz' });
  const profile = await getProfile('cuhksz');
  const origin = profileOrigin(profile);
  const source = process.env.CUHK_CLASSIC_MODE === 'offline-fixture' ? 'offline-fixture' : 'live';
  const scope = `${profile.id}|${origin}|${source}`;
  const provider = options.provider ?? new ClassicProvider({ scope, source, userDataDir: source === 'live' ? classicUserDataDir(scope) : undefined });
  const win = new BrowserWindow({ title: 'CUHK(SZ) · Blackboard Classic', width: 1240, height: 850, minWidth: 800, minHeight: 600, show: false,
    backgroundColor: '#f6f4f9', webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  const handle = (name: string, action: (...args: any[]) => Promise<unknown>) => {
    ipcMain.handle(name, async (event, ...args) => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Unknown sender');
      try { return await action(...args); } catch (error) {
        const safe = error instanceof LmsError ? publicError(error) : publicClassicError(error);
        return { error: safe };
      }
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
  let closing = false;
  win.on('close', event => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    void provider.close().finally(() => { win.destroy(); });
  });
  win.on('closed', () => {
    if (!closing) { closing = true; void provider.close(); }
    app.quit();
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(classicDashboardHTML()));
  win.show(); win.focus();
}
