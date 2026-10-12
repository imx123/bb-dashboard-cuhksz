import { BrowserWindow, dialog, type BrowserWindowConstructorOptions, type Event as ElectronEvent, type Session as ElectronSession, type WebContents, type WebContentsDidStartNavigationEventParams, type WindowOpenHandlerResponse } from 'electron';
import { ClassicApiError } from './api-errors.js';

export interface ClassicLoginController {
  readonly window: BrowserWindow;
  readonly contents: WebContents;
  readonly closed: boolean;
  readonly recovery: boolean;
  focus(): void;
  reveal(target?: BrowserWindow): void;
  waitForRecovery(signal: AbortSignal, timeoutMs: number): Promise<ClassicLoginRecoveryOutcome>;
  close(): Promise<void>;
}

export type ClassicLoginChallengeKind = 'password' | 'otp' | 'mfa' | 'interaction';

export type ClassicLoginRecoveryOutcome =
  | { readonly stage: 'landed' }
  | { readonly stage: 'challenge'; readonly kind: ClassicLoginChallengeKind }
  | { readonly stage: 'unknown'; readonly reason: 'timeout' | 'aborted' | 'closed' | 'network' | 'blocked' };

export interface ClassicLoginWindowOptions {
  readonly origin: string;
  readonly session: ElectronSession;
  readonly signal?: AbortSignal;
  readonly mode?: 'visible' | 'recovery';
  /** Exact origins from the reviewed school SSO chain; no wildcard is accepted. */
  readonly allowedOrigins?: readonly string[] | ReadonlySet<string>;
  /** If an unreviewed HTTPS origin is reached, show a visible one-origin approval prompt. */
  readonly promptOnBlockedNavigation?: boolean;
  /** Let the owning session remember an origin explicitly approved by the user. */
  readonly onApprovedOrigin?: (origin: string) => void;
  readonly onClose?: () => void;
  readonly onBlockedNavigation?: (url: URL) => void;
  readonly onRecoveryEvent?: (event: { readonly stage: 'navigation' | 'auth-link-followed' | 'challenge'; readonly kind?: ClassicLoginChallengeKind; readonly origin?: string; readonly pathname?: string }) => void;
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
    backgroundThrottling: false,
  };
}

function loginWindowOptions(session: ElectronSession, hidden: boolean): BrowserWindowConstructorOptions {
  return {
    show: !hidden,
    skipTaskbar: hidden,
    webPreferences: webPreferences(session),
  };
}

const AUTH_LINK_PATH = /^\/auth-saml\/saml\/login(?:[/?#]|$)/i;
const AUTH_INTERMEDIATE_PATH = /^(?:\/auth-saml\/saml\/login|\/webapps\/login|\/login\.jsp|\/oidcAuth|\/oauth|\/saml)(?:[/?#]|$)/i;

type ChallengeSignals = {
  readonly password: boolean;
  readonly otp: boolean;
  readonly mfa: boolean;
  readonly credential: boolean;
};

function challengeKind(signals: ChallengeSignals): ClassicLoginChallengeKind | null {
  if (signals.password) return 'password';
  if (signals.otp) return 'otp';
  if (signals.mfa) return 'mfa';
  if (signals.credential) return 'interaction';
  return null;
}

const CHALLENGE_SCRIPT = `(() => {
  const visibleInteractive = element => {
    const style = getComputedStyle(element);
    return !element.disabled && style.visibility !== 'hidden' && style.display !== 'none' && (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
  };
  const fields = Array.from(document.querySelectorAll('form input, form textarea, form select')).filter(visibleInteractive);
  const controls = fields.concat(Array.from(document.querySelectorAll('form button, form input[type="submit"]')).filter(visibleInteractive));
  const tokens = controls.map(element => [element.getAttribute('autocomplete'), element.getAttribute('name'), element.getAttribute('id'), element.getAttribute('aria-label')].filter(Boolean).join(' ')).join(' ');
  const editableFields = fields.filter(element => element.tagName !== 'SELECT' && element.readOnly !== true);
  return {
    password: Array.from(document.querySelectorAll('form input[type="password"]')).some(element => visibleInteractive(element) && element.readOnly !== true),
    otp: /one-time|one time|otp|verification.?code|security.?code/i.test(tokens),
    mfa: /mfa|multi.?factor|two.?factor|2fa|authenticator|duo|push.?approval|challenge/i.test(tokens),
    credential: editableFields.some(element => /user.?name|email|account/i.test([element.getAttribute('autocomplete'), element.getAttribute('name'), element.getAttribute('id'), element.getAttribute('aria-label')].filter(Boolean).join(' '))),
  };
})()`;

async function readChallenge(contents: WebContents): Promise<ChallengeSignals | null> {
  if (contents.isDestroyed()) return null;
  try {
    const result = await contents.executeJavaScript(CHALLENGE_SCRIPT);
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    const value = result as Record<string, unknown>;
    return {
      password: value.password === true,
      otp: value.otp === true,
      mfa: value.mfa === true,
      credential: value.credential === true,
    };
  } catch {
    return null;
  }
}

async function findApprovedAuthLink(contents: WebContents, origins: ReadonlySet<string>, apiOrigin: string): Promise<string | null> {
  if (contents.isDestroyed()) return null;
  try {
    const value = await contents.executeJavaScript(`(() => Array.from(document.querySelectorAll('a[href]')).map(anchor => anchor.href).find(href => {
      try { const url = new URL(href, location.href); return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.origin === ${JSON.stringify(apiOrigin)} && ${JSON.stringify(apiOrigin)} === location.origin && /^\\/auth-saml\\/saml\\/login(?:[/?#]|$)/i.test(url.pathname); } catch { return false; }
    }) || null)()`);
    if (typeof value !== 'string' || value.length > 8_000) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !origins.has(url.origin) || !AUTH_LINK_PATH.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
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
  const recovery = options.mode === 'recovery';
  const opened = new Set<BrowserWindow>();
  const pendingApprovals = new Set<string>();
  const followedAuthLinks = new Set<string>();
  let sawSsoNavigation = false;
  let recoveryBlocked = false;
  let closed = false;
  let closing = false;
  let activeWindow: BrowserWindow | undefined;
  let recoveryWatcher: ((browserWindow: BrowserWindow) => void) | undefined;
  let recoveryFinish: ((outcome: ClassicLoginRecoveryOutcome) => void) | undefined;
  let controllerRef: ClassicLoginController | undefined;

  const window = new BrowserWindow({
    title: 'Blackboard 登录',
    width: 1040,
    height: 780,
    minWidth: 640,
    minHeight: 520,
    ...loginWindowOptions(options.session, recovery),
  });
  activeWindow = window;
  const contents = window.webContents;

  const requestApproval = (value: string, source?: WebContents): void => {
    if (options.promptOnBlockedNavigation === false || recovery) return;
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
    if (parsed) {
      if (recovery && (parsed.origin !== origin || AUTH_INTERMEDIATE_PATH.test(parsed.pathname))) sawSsoNavigation = true;
      return true;
    }
    try { options.onBlockedNavigation?.(new URL(value)); } catch { /* Diagnostics cannot affect login. */ }
    if (recovery) {
      recoveryBlocked = true;
      recoveryFinish?.({ stage: 'unknown', reason: 'blocked' });
    }
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
      return { action: 'allow', overrideBrowserWindowOptions: loginWindowOptions(options.session, recovery) };
    });
    childContents.on('did-create-window', grandchild => harden(grandchild));
    child.on('closed', () => {
      opened.delete(child);
      if (recovery && activeWindow === child && !closing) {
        const finish = recoveryFinish;
        if (finish) finish({ stage: 'unknown', reason: 'closed' });
        else void controllerRef?.close();
      }
    });
    recoveryWatcher?.(child);
  };

  const controller: ClassicLoginController = {
    window,
    contents,
    get closed() { return closed || window.isDestroyed(); },
    recovery,
    focus() {
      const target = activeWindow && !activeWindow.isDestroyed() ? activeWindow : window;
      if (target.isDestroyed()) return;
      if (!target.isVisible()) target.show();
      target.focus();
    },
    reveal(target = window) {
      if (target.isDestroyed()) return;
      activeWindow = target;
      target.setSkipTaskbar(false);
      if (!target.isVisible()) target.show();
      target.focus();
    },
    waitForRecovery: async (signal, timeoutMs) => {
      if (!recovery) return { stage: 'landed' };
      return new Promise<ClassicLoginRecoveryOutcome>(resolve => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let pollTimer: ReturnType<typeof setInterval> | undefined;
        const stabilizers = new Set<ReturnType<typeof setTimeout>>();
        const listeners = new Map<WebContents, Array<() => void>>();
        const stable = new Map<WebContents, boolean>();
        const stableSince = new Map<WebContents, number>();
        const inspections = new Set<WebContents>();
        const loggedNavigations = new Set<string>();
        const finish = (outcome: ClassicLoginRecoveryOutcome): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (pollTimer) clearInterval(pollTimer);
          for (const stabilizer of stabilizers) clearTimeout(stabilizer);
          signal.removeEventListener('abort', onAbort);
          for (const removers of listeners.values()) {
            for (const remove of removers) remove();
          }
          listeners.clear();
          stable.clear();
          stableSince.clear();
          inspections.clear();
          loggedNavigations.clear();
          recoveryWatcher = undefined;
          if (recoveryFinish === finish) recoveryFinish = undefined;
          resolve(outcome);
        };
        recoveryFinish = finish;
        const onAbort = (): void => finish({ stage: 'unknown', reason: 'aborted' });
        if (recoveryBlocked) {
          finish({ stage: 'unknown', reason: 'blocked' });
          return;
        }
        const inspect = async (browserWindow: BrowserWindow): Promise<void> => {
          if (settled || browserWindow.isDestroyed() || !stable.get(browserWindow.webContents) || inspections.has(browserWindow.webContents)) return;
          const webContents = browserWindow.webContents;
          inspections.add(webContents);
          try {
            let current: URL;
            try { current = new URL(webContents.getURL()); } catch { return; }
            if (current.origin !== origin || AUTH_INTERMEDIATE_PATH.test(current.pathname)) sawSsoNavigation = true;
            const isMainFrameLoading = (): boolean => {
              try { return webContents.isLoadingMainFrame(); } catch { return true; }
            };
            if (!origins.has(current.origin) || isMainFrameLoading()) return;
            const navigationKey = `${current.origin}${current.pathname}`;
            if (!loggedNavigations.has(navigationKey)) {
              loggedNavigations.add(navigationKey);
              try { options.onRecoveryEvent?.({ stage: 'navigation', origin: current.origin, pathname: current.pathname.slice(0, 300) }); } catch { /* Diagnostics cannot affect recovery. */ }
            }
            // The reviewed BB page gets the first chance to expose the actual
            // auth-saml login anchor. Only after that lookup fails do we
            // classify a same-page credential form as an interaction challenge.
            if (current.origin === origin && !followedAuthLinks.size) {
              const authLink = await findApprovedAuthLink(webContents, origins, origin);
              if (settled || browserWindow.isDestroyed() || isMainFrameLoading()) return;
              let afterLinkLookup: URL;
              try { afterLinkLookup = new URL(webContents.getURL()); } catch { return; }
              if (afterLinkLookup.href !== current.href) return;
              if (authLink && !followedAuthLinks.has(authLink)) {
                followedAuthLinks.add(authLink);
                sawSsoNavigation = true;
                stable.set(webContents, false);
                stableSince.delete(webContents);
                try {
                  const approved = new URL(authLink);
                  options.onRecoveryEvent?.({ stage: 'auth-link-followed', origin: approved.origin, pathname: approved.pathname });
                } catch { /* Diagnostics cannot affect recovery. */ }
                try {
                  await webContents.loadURL(authLink);
                  if (!settled && !browserWindow.isDestroyed()) {
                    stable.set(webContents, true);
                    stableSince.set(webContents, Date.now());
                  }
                } catch { finish({ stage: 'unknown', reason: 'network' }); }
                return;
              }
            }
            const signals = await readChallenge(webContents);
            if (settled || browserWindow.isDestroyed() || isMainFrameLoading()) return;
            let afterChallenge: URL;
            try { afterChallenge = new URL(webContents.getURL()); } catch { return; }
            if (afterChallenge.href !== current.href) return;
            const kind = signals ? challengeKind(signals) : null;
            if (kind) {
              activeWindow = browserWindow;
              controller.reveal(browserWindow);
              try { options.onRecoveryEvent?.({ stage: 'challenge', kind }); } catch { /* Diagnostics cannot affect recovery. */ }
              finish({ stage: 'challenge', kind });
              return;
            }
            const surfaceWaiting = [window, ...opened].some(surface => {
              if (surface === browserWindow || surface.isDestroyed()) return false;
              const surfaceContents = surface.webContents;
              if (!stable.get(surfaceContents)) return true;
              try {
                if (surfaceContents.isLoadingMainFrame()) return true;
                const surfaceUrl = new URL(surfaceContents.getURL());
                return surfaceUrl.origin !== origin || AUTH_INTERMEDIATE_PATH.test(surfaceUrl.pathname);
              } catch { return true; }
            });
            if (sawSsoNavigation && current.origin === origin && !AUTH_INTERMEDIATE_PATH.test(current.pathname) && !surfaceWaiting && !isMainFrameLoading() && Date.now() - (stableSince.get(webContents) ?? Date.now()) >= 750) finish({ stage: 'landed' });
          } finally {
            inspections.delete(webContents);
          }
        };
        const inspectSafely = (browserWindow: BrowserWindow): void => {
          void inspect(browserWindow).catch(() => {
            if (!settled) finish({ stage: 'unknown', reason: 'network' });
          });
        };
        const attach = (browserWindow: BrowserWindow, initiallyStable = false): void => {
          if (browserWindow.isDestroyed() || listeners.has(browserWindow.webContents)) return;
          const webContents = browserWindow.webContents;
          const markStable = (): void => {
            stable.set(webContents, true);
            stableSince.set(webContents, Date.now());
            inspectSafely(browserWindow);
          };
          const onStartNavigation = (details: ElectronEvent<WebContentsDidStartNavigationEventParams>): void => {
            if (details.isMainFrame) {
              try { const navigationUrl = new URL(details.url); if (navigationUrl.origin !== origin || AUTH_INTERMEDIATE_PATH.test(navigationUrl.pathname)) sawSsoNavigation = true; } catch { /* The later stable URL check remains authoritative. */ }
              stable.set(webContents, false);
              stableSince.delete(webContents);
            }
          };
          // did-navigate is emitted for main-frame navigations only.
          const onNavigate = (): void => { stable.set(webContents, false); stableSince.delete(webContents); };
          const onNavigateInPage = (_event: ElectronEvent, _url: string, isMainFrame: boolean): void => {
            if (isMainFrame === false) return;
            stable.set(webContents, false);
            stableSince.delete(webContents);
            const stabilizer = setTimeout(() => {
              stabilizers.delete(stabilizer);
              if (!settled && !browserWindow.isDestroyed()) markStable();
            }, 0);
            stabilizers.add(stabilizer);
          };
          const onFailLoad = (_event: ElectronEvent, errorCode: number, _description: string, _validatedURL: string, isMainFrame: boolean): void => {
            if (isMainFrame && errorCode !== -3) finish({ stage: 'unknown', reason: 'network' });
          };
          // Keep literal event names paired with their callbacks for Electron's
          // overloads, and retain the same callbacks for deterministic cleanup.
          webContents.on('did-start-navigation', onStartNavigation);
          webContents.on('did-navigate', onNavigate);
          webContents.on('did-finish-load', markStable);
          webContents.on('did-navigate-in-page', onNavigateInPage);
          webContents.on('did-fail-load', onFailLoad);
          listeners.set(webContents, [
            () => { webContents.removeListener('did-start-navigation', onStartNavigation); },
            () => { webContents.removeListener('did-navigate', onNavigate); },
            () => { webContents.removeListener('did-finish-load', markStable); },
            () => { webContents.removeListener('did-navigate-in-page', onNavigateInPage); },
            () => { webContents.removeListener('did-fail-load', onFailLoad); },
          ]);
          stable.set(webContents, initiallyStable);
          if (initiallyStable) {
            stableSince.set(webContents, Date.now());
            inspectSafely(browserWindow);
          }
        };
        // Replace the placeholder watcher with the concrete attach function
        // while the recovery promise is active; newly opened children inherit
        // the same hidden/reveal policy.
        recoveryWatcher = attach;
        attach(window, true);
        for (const child of opened) {
          let initiallyStable = false;
          try { initiallyStable = !child.webContents.isLoading(); } catch { /* The child may close during setup. */ }
          attach(child, initiallyStable);
        }
        if (signal.aborted) { finish({ stage: 'unknown', reason: 'aborted' }); return; }
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => finish({ stage: 'unknown', reason: 'timeout' }), Math.max(1_000, Math.min(timeoutMs, 60_000)));
        pollTimer = setInterval(() => {
          if (settled) return;
          for (const browserWindow of [window, ...opened]) inspectSafely(browserWindow);
        }, 750);
      });
    },
    async close() {
      if (closing) return;
      closing = true;
      closed = true;
      recoveryFinish?.({ stage: 'unknown', reason: 'closed' });
      if (!window.isDestroyed()) recovery ? window.destroy() : window.close();
      for (const child of [...opened]) if (!child.isDestroyed()) recovery ? child.destroy() : child.close();
    },
  };
  controllerRef = controller;

  contents.on('will-navigate', (event, url) => { if (!block(url, contents)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!block(url, contents)) event.preventDefault(); });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.setWindowOpenHandler(({ url }): WindowOpenHandlerResponse => {
    if (!block(url, contents)) return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: loginWindowOptions(options.session, recovery) };
  });
  contents.on('did-create-window', child => harden(child));
  window.on('closed', () => {
    closed = true;
    for (const child of [...opened]) if (!child.isDestroyed()) recovery ? child.destroy() : child.close();
    recoveryFinish?.({ stage: 'unknown', reason: 'closed' });
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

