import { BrowserWindow, dialog, type BrowserWindowConstructorOptions, type Session as ElectronSession, type WebContents, type WindowOpenHandlerResponse } from 'electron';
import { ClassicApiError } from './api-errors.js';

export interface ClassicLoginController {
  readonly window: BrowserWindow;
  readonly contents: WebContents;
  readonly closed: boolean;
  close(): Promise<void>;
}

export interface ClassicLoginWindowOptions {
  readonly origin: string;
  readonly session: ElectronSession;
  readonly signal?: AbortSignal;
  /** Exact origins from the reviewed school SSO chain; no wildcard is accepted. */
  readonly allowedOrigins?: readonly string[] | ReadonlySet<string>;
  /** If an unreviewed HTTPS origin is reached, show a visible one-origin approval prompt. */
  readonly promptOnBlockedNavigation?: boolean;
  /** Let the owning session remember an origin explicitly approved by the user. */
  readonly onApprovedOrigin?: (origin: string) => void;
  readonly onClose?: () => void;
  readonly onBlockedNavigation?: (url: URL) => void;
}

function originOf(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new ClassicApiError('URL_REJECTED', 'Classic 登录入口必须是固定 HTTPS origin。', { scope: 'session.login', retryable: false });
  }
}

function approvedOrigins(options: ClassicLoginWindowOptions): Set<string> {
  const values = [options.origin, ...Array.from(options.allowedOrigins ?? [])].map(originOf);
  return new Set(values);
}

function safeNavigation(value: string, origins: ReadonlySet<string>): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !origins.has(url.origin)) return null;
    return url;
  } catch {
    return null;
  }
}

function webPreferences(session: ElectronSession): NonNullable<BrowserWindowConstructorOptions['webPreferences']> {
  return {
    session,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
  };
}

/**
 * Open the reviewed official login chain in a dedicated persistent partition.
 * The remote page receives no local preload and no Node capability. Unknown
 * SSO origins are blocked until the caller supplies the exact reviewed origin;
 * this avoids guessing a provider domain or allowing arbitrary HTTPS pages.
 */
export async function createClassicLoginWindow(options: ClassicLoginWindowOptions): Promise<ClassicLoginController> {
  const origin = originOf(options.origin);
  const origins = approvedOrigins(options);
  const opened = new Set<BrowserWindow>();
  const pendingApprovals = new Set<string>();
  let closed = false;
  let closing = false;

  const window = new BrowserWindow({
    title: 'Blackboard 登录',
    width: 1040,
    height: 780,
    minWidth: 640,
    minHeight: 520,
    show: true,
    webPreferences: webPreferences(options.session),
  });
  const contents = window.webContents;

  const requestApproval = (value: string, source?: WebContents): void => {
    if (options.promptOnBlockedNavigation === false) return;
    let target: URL;
    try { target = new URL(value); } catch { return; }
    const targetOrigin = target.origin;
    if (target.protocol !== 'https:' || target.username || target.password || target.port || targetOrigin === 'null' || origins.has(targetOrigin) || pendingApprovals.has(targetOrigin)) return;
    if (window.isDestroyed()) return;
    pendingApprovals.add(targetOrigin);
    void dialog.showMessageBox(window, {
      type: 'question',
      buttons: ['允许此官方认证来源', '拒绝'],
      defaultId: 1,
      cancelId: 1,
      title: '确认学校认证来源',
      message: `Blackboard 登录请求打开认证来源：${targetOrigin}`,
      detail: '只允许你明确确认的 HTTPS origin；不会显示或保存 URL 查询参数。',
    }).then(result => {
      if (result.response !== 0 || window.isDestroyed()) return;
      origins.add(targetOrigin);
      try { options.onApprovedOrigin?.(targetOrigin); } catch { /* Session diagnostics cannot affect the visible login flow. */ }
      // A blocked popup/redirect may have been initiated by a POST form. Never
      // replay it as loadURL(GET); the user can retry the original official
      // button now that this exact origin is approved.
      const retryHint = source && !source.isDestroyed()
        ? '请回到当前登录页重新点击原认证按钮。'
        : '请重新打开官方登录入口。';
      if (!window.isDestroyed()) void dialog.showMessageBox(window, {
        type: 'info',
        buttons: ['知道了'],
        title: '认证来源已允许',
        message: `已允许认证来源：${targetOrigin}`,
        detail: retryHint,
      }).catch(() => {});
    }).catch(() => {}).finally(() => pendingApprovals.delete(targetOrigin));
  };

  const block = (value: string, source?: WebContents): boolean => {
    const parsed = safeNavigation(value, origins);
    if (parsed) return true;
    try { options.onBlockedNavigation?.(new URL(value)); } catch { /* Diagnostics cannot affect login. */ }
    requestApproval(value, source);
    return false;
  };

  const harden = (child: BrowserWindow): void => {
    opened.add(child);
    const childContents = child.webContents;
    childContents.on('will-navigate', (event, url) => { if (!block(url, childContents)) event.preventDefault(); });
    childContents.on('will-redirect', (event, url) => { if (!block(url, childContents)) event.preventDefault(); });
    childContents.setWindowOpenHandler(({ url }): WindowOpenHandlerResponse => {
      if (!block(url, childContents)) return { action: 'deny' };
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: webPreferences(options.session) } };
    });
    childContents.on('did-create-window', grandchild => harden(grandchild));
    child.on('closed', () => opened.delete(child));
  };

  const controller: ClassicLoginController = {
    window,
    contents,
    get closed() { return closed || window.isDestroyed(); },
    async close() {
      if (closing) return;
      closing = true;
      if (!window.isDestroyed()) window.close();
      for (const child of [...opened]) if (!child.isDestroyed()) child.close();
      closed = true;
    },
  };

  contents.on('will-navigate', (event, url) => { if (!block(url, contents)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!block(url, contents)) event.preventDefault(); });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.setWindowOpenHandler(({ url }): WindowOpenHandlerResponse => {
    if (!block(url, contents)) return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: webPreferences(options.session) } };
  });
  contents.on('did-create-window', child => harden(child));
  window.on('closed', () => {
    closed = true;
    for (const child of [...opened]) if (!child.isDestroyed()) child.close();
    options.onClose?.();
  });

  const cancelled = () => { void controller.close(); };
  if (options.signal?.aborted) {
    await controller.close();
    throw new ClassicApiError('AUTH_REQUIRED', 'Classic 登录已取消。', { scope: 'session.login', retryable: false });
  }
  options.signal?.addEventListener('abort', cancelled, { once: true });
  try {
    await contents.loadURL(`${origin}/`);
  } catch (error) {
    if (!options.signal?.aborted && !closed && pendingApprovals.size === 0) {
      await controller.close();
      throw new ClassicApiError('NETWORK', 'Blackboard 官方登录页面无法打开。', { scope: 'session.login', retryable: true, cause: error });
    }
  } finally {
    options.signal?.removeEventListener('abort', cancelled);
  }
  if (options.signal?.aborted) {
    await controller.close();
    throw new ClassicApiError('AUTH_REQUIRED', 'Classic 登录已取消。', { scope: 'session.login', retryable: false });
  }
  return controller;
}

