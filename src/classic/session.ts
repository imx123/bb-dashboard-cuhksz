import { session as electronSession, type Session as ElectronSession } from 'electron';
import { Cookie, CookieJar } from 'tough-cookie';
import type { Profile } from '../config.js';
import { debugLog } from '../debug-log.js';
import {
  ClassicApiError,
  isAuthenticationError,
  type ClassicApiErrorCode,
} from './api-errors.js';
import type {
  ClassicAccountContext,
  ClassicApiOrigin,
  ClassicApiResponse,
  ClassicCookie,
  ClassicSession as ClassicSessionContract,
  ClassicSessionSnapshot,
  TraceId,
} from './api-contract.js';
import { ClassicHttpClient } from './http.js';
import { createClassicLoginWindow, type ClassicLoginController } from './login.js';

const API_ORIGIN = 'https://bb.cuhk.edu.cn' as ClassicApiOrigin;
const LOGIN_AUTH_ORIGINS = ['https://sts.cuhk.edu.cn'] as const;
const IDENTITY_PATH = '/learn/api/v1/users/me';
const MEMBERSHIPS_PATH = '/learn/api/v1/users/me/memberships?expand=course&limit=100';
const COOKIE_VALUE_LIMIT = 16_384;
const AUTH_CACHE_MS = 30_000;

type RecordValue = Record<string, unknown>;
type SessionCookie = ClassicCookie & {
  readonly httpOnly: boolean;
  readonly hostOnly: boolean | null;
  readonly sameSite: string | undefined;
};

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function abortIfNeeded(signal?: AbortSignal, scope = 'session'): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof ClassicApiError) throw signal.reason;
  throw new ClassicApiError('TIMEOUT', 'Classic 操作已取消或超时。', { scope, retryable: false });
}

function originOf(value: string): ClassicApiOrigin {
  const url = new URL(value);
  if (url.origin !== API_ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new ClassicApiError('URL_REJECTED', 'Classic API 仅允许固定学校 HTTPS origin。', { scope: 'session.origin', retryable: false });
  }
  return url.origin as ClassicApiOrigin;
}

function partitionFor(profileId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(profileId)) {
    throw new ClassicApiError('BAD_INPUT', 'Classic profile ID 无效。', { scope: 'session.partition', retryable: false });
  }
  return `persist:lms-classic-${profileId}`;
}

function cookieOriginUrl(url: URL): string {
  return `${url.origin}${url.pathname || '/'}`;
}

function cookieKey(cookie: Pick<ClassicCookie, 'name' | 'domain' | 'path'>): string {
  return `${cookie.name}\0${cookie.domain.toLowerCase()}\0${cookie.path}`;
}

function asCookie(value: Electron.Cookie): SessionCookie | null {
  if (!value.name || value.value.length > COOKIE_VALUE_LIMIT) return null;
  const domain = (value.domain ?? new URL(API_ORIGIN).hostname).replace(/^\./, '').toLowerCase();
  const host = new URL(API_ORIGIN).hostname;
  if (domain !== host && !host.endsWith(`.${domain}`) && !domain.endsWith(`.${host}`)) return null;
  const path = value.path && value.path.startsWith('/') ? value.path : '/';
  const expiresAt = typeof value.expirationDate === 'number' && Number.isFinite(value.expirationDate)
    ? value.expirationDate * 1000 : null;
  if (expiresAt !== null && expiresAt <= Date.now()) return null;
  return {
    name: value.name,
    value: value.value,
    domain,
    path,
    secure: value.secure === true,
    expiresAt,
    httpOnly: value.httpOnly === true,
    hostOnly: value.hostOnly ?? null,
    sameSite: value.sameSite,
  };
}

function cookieToElectron(cookie: Cookie, url: URL): Electron.CookiesSetDetails | null {
  const domain = typeof cookie.domain === 'string' ? cookie.domain.replace(/^\./, '').toLowerCase() : url.hostname;
  const host = url.hostname.toLowerCase();
  if (domain !== host && !host.endsWith(`.${domain}`) && !domain.endsWith(`.${host}`)) return null;
  if (!cookie.key || cookie.value.length > COOKIE_VALUE_LIMIT) return null;
  const expires = cookie.expiryTime();
  const details: Electron.CookiesSetDetails = {
    url: cookieOriginUrl(url),
    name: cookie.key,
    value: cookie.value,
    // Electron has no separate hostOnly flag. Omitting Domain preserves the
    // host-only scope; copying a parsed host-only cookie as Domain=host would
    // silently widen it to subdomains.
    domain: cookie.hostOnly === true ? undefined : cookie.domain ?? undefined,
    path: cookie.path ?? '/',
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite === 'lax' ? 'lax' : cookie.sameSite === 'strict' ? 'strict' : cookie.sameSite === 'none' ? 'no_restriction' : 'unspecified',
  };
  if (expires !== undefined && Number.isFinite(expires) && expires > Date.now()) details.expirationDate = expires / 1000;
  return details;
}

function cookieRemovalUrl(url: URL, cookie: Cookie): string {
  const target = new URL(url.origin);
  target.pathname = cookie.path && cookie.path.startsWith('/') ? cookie.path : '/';
  return target.href;
}

function splitSetCookieHeader(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let inExpires = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === ';') inExpires = false;
    else if (char === ',' && !inExpires) {
      const next = value.slice(index + 1);
      if (/^\s*[^;,=\s]+\s*=/.test(next)) {
        const item = value.slice(start, index).trim();
        if (item) result.push(item);
        start = index + 1;
      }
    } else if (char === '=' && /expires$/i.test(value.slice(Math.max(start, index - 8), index).trim())) {
      inExpires = true;
    }
  }
  const final = value.slice(start).trim();
  if (final) result.push(final);
  return result;
}

function setCookieValues(headers: readonly string[]): string[] {
  return headers.flatMap(value => value.length <= COOKIE_VALUE_LIMIT * 2 ? splitSetCookieHeader(value) : []).slice(0, 50);
}

function readId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const id = String(value).trim();
  return id.length > 0 && id.length <= 300 ? id : null;
}

function bodyRecord(response: ClassicApiResponse<unknown>, scope: string): RecordValue {
  if (!isRecord(response.data)) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 身份响应结构无法识别。', { scope });
  return response.data;
}

function budget(signal: AbortSignal, deadlineAt: number) {
  return { signal, deadlineAt, requestLimit: 8, responseBytesLimit: 2_000_000 } as const;
}

/**
 * The live Classic session is an in-memory CookieJar backed by one persistent
 * Electron partition. Cookies are read from Electron and Set-Cookie updates
 * are mirrored back into that same partition; no cookie is written to vault or
 * sent across the renderer/MCP boundary.
 */
export class ClassicSession implements ClassicSessionContract {
  readonly profileId: string;
  readonly origin: ClassicApiOrigin = API_ORIGIN;
  readonly partition: string;
  readonly electronSession: ElectronSession;
  private jar = new CookieJar();
  private readonly allowedLoginOrigins: Set<string>;
  private stateValue: ClassicSessionContract['state'] = 'unauthenticated';
  private accountValue: ClassicAccountContext | null = null;
  private generationValue = 0;
  private loginController?: ClassicLoginController;
  private authFlight?: Promise<ClassicSessionSnapshot>;
  private authenticatedAt = 0;
  private readonly requestControllers = new Set<AbortController>();
  private closed = false;

  constructor(profile: Pick<Profile, 'id' | 'blackboard'> | { profileId: string; origin?: string }, options: { partition?: string; allowedLoginOrigins?: readonly string[] } = {}) {
    const profileId = 'profileId' in profile ? profile.profileId : profile.id;
    const origin = 'profileId' in profile ? profile.origin ?? API_ORIGIN : profile.blackboard ?? API_ORIGIN;
    if (originOf(origin) !== API_ORIGIN) throw new ClassicApiError('URL_REJECTED', 'Classic API origin 不匹配。', { scope: 'session.origin', retryable: false });
    this.profileId = profileId;
    this.partition = options.partition ?? partitionFor(profileId);
    this.allowedLoginOrigins = new Set([...LOGIN_AUTH_ORIGINS, ...(options.allowedLoginOrigins ?? [])]);
    this.electronSession = electronSession.fromPartition(this.partition);
    this.electronSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.electronSession.setPermissionCheckHandler(() => false);
    this.electronSession.on('will-download', event => event.preventDefault());
  }

  get state() { return this.stateValue; }
  get account() { return this.accountValue; }
  get generation() { return this.generationValue; }

  private snapshot(errorCode?: ClassicApiErrorCode): ClassicSessionSnapshot {
    return {
      state: this.stateValue,
      account: this.accountValue,
      generation: this.generationValue,
      ...(errorCode ? { errorCode } : {}),
    };
  }

  private advance(state: ClassicSessionContract['state']): void {
    this.generationValue += 1;
    for (const controller of this.requestControllers) controller.abort(new Error('Classic session generation changed.'));
    this.requestControllers.clear();
    this.accountValue = null;
    this.authenticatedAt = 0;
    this.stateValue = state;
    // Replacing the jar makes in-flight refresh/apply operations from the
    // previous generation harmless; they retain the old object and cannot
    // write into the new account's cookie view.
    this.jar = new CookieJar();
  }

  /** Internal transport hook; the public contract intentionally hides it. */
  captureGeneration(): number { return this.generationValue; }
  /** Internal transport hook; the public contract intentionally hides it. */
  isGenerationCurrent(generation: number): boolean { return !this.closed && generation === this.generationValue; }
  /** Internal transport hook; the public contract intentionally hides it. */
  registerRequest(controller: AbortController): () => void {
    this.requestControllers.add(controller);
    return () => this.requestControllers.delete(controller);
  }

  /** Internal transport hook for a confirmed 401/login response. */
  markExpired(): void {
    if (this.closed) return;
    this.authFlight = undefined;
    if (this.stateValue !== 'expired') this.advance('expired');
  }

  /** Only explicitly configured SSO origins may classify an external redirect
   * as authentication expiry; arbitrary CDN/resource origins stay rejected. */
  isKnownAuthOrigin(url: URL): boolean {
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && this.allowedLoginOrigins.has(url.origin);
  }

  async beginLogin(signal?: AbortSignal, traceId?: TraceId): Promise<ClassicSessionSnapshot> {
    abortIfNeeded(signal, 'session.login');
    if (this.closed) throw new ClassicApiError('AUTH_REQUIRED', 'Classic session 已关闭，请重新打开登录。', { scope: 'session.login', retryable: false });
    if (this.stateValue === 'authenticating' && this.loginController && !this.loginController.closed) {
      this.loginController.window.focus();
      return this.snapshot();
    }
    const previousController = this.loginController;
    this.loginController = undefined;
    if (previousController && !previousController.closed) await previousController.close().catch(() => {});
    this.advance('authenticating');
    this.authFlight = undefined;
    debugLog.event('classic.api.session.login.begin', { traceId, origin: this.origin });
    try {
      this.loginController = await createClassicLoginWindow({
        origin: this.origin,
        session: this.electronSession,
        signal,
        allowedOrigins: this.allowedLoginOrigins,
        onApprovedOrigin: origin => this.allowedLoginOrigins.add(origin),
        onClose: () => {
          if (this.stateValue === 'authenticating') this.stateValue = 'unauthenticated';
        },
        onBlockedNavigation: url => debugLog.event('classic.api.session.login.blocked-origin', { traceId, origin: url.origin }),
      });
    } catch (error) {
      if (this.stateValue === 'authenticating') this.stateValue = 'unauthenticated';
      this.loginController = undefined;
      throw error;
    }
    return this.snapshot();
  }

  async completeLogin(signal?: AbortSignal, traceId?: TraceId): Promise<ClassicSessionSnapshot> {
    abortIfNeeded(signal, 'session.login');
    if (this.closed) throw new ClassicApiError('AUTH_REQUIRED', 'Classic session 已关闭，请重新打开登录。', { scope: 'session.login', retryable: false });
    if (this.stateValue !== 'authenticating' && this.stateValue !== 'authenticated') this.advance('authenticating');
    if (this.authFlight) return this.authFlight;
    return this.startAuthFlight(signal, traceId, true);
  }

  async restore(signal?: AbortSignal, traceId?: TraceId): Promise<ClassicSessionSnapshot> {
    abortIfNeeded(signal, 'session.restore');
    if (this.closed) throw new ClassicApiError('AUTH_REQUIRED', 'Classic session 已关闭，请重新打开登录。', { scope: 'session.restore', retryable: false });
    if (this.stateValue === 'authenticating' && this.loginController && !this.loginController.closed) return this.snapshot();
    if (this.stateValue === 'authenticated' && this.accountValue && Date.now() - this.authenticatedAt < AUTH_CACHE_MS) return this.snapshot();
    if (this.authFlight) return this.authFlight;
    // Cookie presence at the partition root is not an authentication signal:
    // valid Blackboard cookies may be scoped to /learn. Always verify the
    // identity endpoint so the server remains the authority on session state.
    this.stateValue = 'authenticating';
    debugLog.event('classic.api.session.restore.begin', { traceId, origin: this.origin });
    return this.startAuthFlight(signal, traceId, false);
  }

  async ensureAuthenticated(signal: AbortSignal, traceId?: TraceId): Promise<ClassicSessionSnapshot> {
    abortIfNeeded(signal, 'session.auth');
    if (this.stateValue === 'unauthenticated') {
      throw new ClassicApiError('AUTH_REQUIRED', '请先通过 Classic 官方登录窗口完成登录。', { scope: 'session.auth', retryable: false });
    }
    if (this.stateValue === 'authenticated' && this.accountValue && Date.now() - this.authenticatedAt < AUTH_CACHE_MS) return this.snapshot();
    if (this.authFlight) return this.authFlight;
    return this.startAuthFlight(signal, traceId, false);
  }

  private startAuthFlight(signal: AbortSignal | undefined, traceId: TraceId | undefined, fromLogin: boolean): Promise<ClassicSessionSnapshot> {
    const flight = this.verifyIdentity(signal, traceId, fromLogin);
    this.authFlight = flight;
    void flight.then(
      () => { if (this.authFlight === flight) this.authFlight = undefined; },
      () => { if (this.authFlight === flight) this.authFlight = undefined; },
    );
    return flight;
  }

  private async verifyIdentity(signal: AbortSignal | undefined, traceId: TraceId | undefined, fromLogin: boolean): Promise<ClassicSessionSnapshot> {
    const requestSignal = signal ?? new AbortController().signal;
    const generationAtStart = this.generationValue;
    const started = Date.now();
    try {
      await this.refreshFromElectron(requestSignal, generationAtStart);
      if (!this.isGenerationCurrent(generationAtStart)) throw new ClassicApiError('AUTH_REQUIRED', 'Classic 会话已改变，请重新读取。', { scope: 'session.identity', retryable: false });
      const http = new ClassicHttpClient(this);
      const deadlineAt = Date.now() + 15_000;
      const requestBudget = budget(requestSignal, deadlineAt);
      const identity = await http.request<RecordValue>({
        method: 'GET',
        url: new URL(IDENTITY_PATH, this.origin),
        resource: 'identity',
        traceId,
        budget: requestBudget,
      });
      if (!this.isGenerationCurrent(generationAtStart)) throw new ClassicApiError('AUTH_REQUIRED', 'Classic 会话已改变，请重新读取。', { scope: 'session.identity', retryable: false });
      const me = bodyRecord(identity, 'session.identity');
      const userId = readId(me.id ?? me.userId);
      if (!userId) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 身份响应缺少用户 ID。', { scope: 'session.identity' });
      if (this.accountValue?.userId && this.accountValue.userId !== userId) {
        this.authFlight = undefined;
        this.advance('authenticating');
        throw new ClassicApiError('AUTH_REQUIRED', 'Blackboard 账号已切换，请重新确认当前会话。', { scope: 'session.identity', retryable: false });
      }
      const memberships = await http.request<RecordValue>({
        method: 'GET',
        url: new URL(MEMBERSHIPS_PATH, this.origin),
        resource: 'memberships',
        traceId,
        budget: requestBudget,
      });
      if (!this.isGenerationCurrent(generationAtStart)) throw new ClassicApiError('AUTH_REQUIRED', 'Classic 会话已改变，请重新读取。', { scope: 'session.memberships', retryable: false });
      const membershipBody = bodyRecord(memberships, 'session.memberships');
      if (!Array.isArray(membershipBody.results)) {
        throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard memberships 响应缺少结果数组。', { scope: 'session.memberships' });
      }
      abortIfNeeded(requestSignal, 'session.identity');
      this.accountValue = {
        profileId: this.profileId,
        origin: this.origin,
        userId,
        sessionGeneration: this.generationValue,
        timezone: 'Asia/Shanghai',
      };
      this.stateValue = 'authenticated';
      this.authenticatedAt = Date.now();
      debugLog.event('classic.api.session.authenticated', { traceId, elapsedMs: Date.now() - started, fromLogin, membershipCount: membershipBody.results.length });
      await this.flushCookieStore(fromLogin ? 'login' : 'restore');
      abortIfNeeded(requestSignal, 'session.identity');
      if (!this.isGenerationCurrent(generationAtStart)) throw new ClassicApiError('AUTH_REQUIRED', 'Classic 会话已改变，请重新读取。', { scope: 'session.identity', retryable: false });
      return this.snapshot();
    } catch (error) {
      if (!this.isGenerationCurrent(generationAtStart)) throw error;
      const code = error instanceof ClassicApiError && isAuthenticationError(error) ? error.code : undefined;
      if (code) {
        this.authFlight = undefined;
        this.advance('expired');
        debugLog.event('classic.api.session.expired', { traceId, elapsedMs: Date.now() - started, code });
      } else {
        this.stateValue = 'unknown';
        debugLog.event('classic.api.session.unknown', { traceId, elapsedMs: Date.now() - started, errorType: error instanceof Error ? error.name : 'Error' });
      }
      throw error;
    }
  }

  async cookiesFor(url: URL, signal?: AbortSignal): Promise<readonly ClassicCookie[]> {
    abortIfNeeded(signal, 'session.cookies');
    if (url.protocol !== 'https:' || url.origin !== this.origin || url.username || url.password || url.port) {
      throw new ClassicApiError('URL_REJECTED', 'Classic session 不向其他 origin 发送 Cookie。', { scope: 'session.cookies', retryable: false });
    }
    const electronCookies = await this.electronSession.cookies.get({ url: cookieOriginUrl(url) });
    abortIfNeeded(signal, 'session.cookies');
    const current = new Map<string, ClassicCookie>();
    for (const cookie of electronCookies) {
      const parsed = asCookie(cookie);
      if (parsed) current.set(cookieKey(parsed), parsed);
    }
    // Electron's partition is authoritative. Never fill missing keys from the
    // mirror: an Electron-side logout/expiry must not be revived by stale jar state.
    return [...current.values()].filter(cookie => cookie.secure || url.protocol === 'https:');
  }

  async applySetCookie(url: URL, values: readonly string[], signal?: AbortSignal): Promise<void> {
    abortIfNeeded(signal, 'session.cookies');
    if (url.protocol !== 'https:' || url.origin !== this.origin || url.username || url.password || url.port) {
      throw new ClassicApiError('URL_REJECTED', 'Classic session 不接收其他 origin 的 Set-Cookie。', { scope: 'session.cookies', retryable: false });
    }
    const jar = this.jar;
    const expectedGeneration = this.generationValue;
    for (const raw of setCookieValues(values)) {
      abortIfNeeded(signal, 'session.cookies');
      if (!this.isGenerationCurrent(expectedGeneration)) throw new ClassicApiError('AUTH_REQUIRED', 'Classic 会话已改变，请重新读取。', { scope: 'session.cookies', retryable: false });
      const parsed = Cookie.parse(raw);
      if (!parsed || !parsed.key || parsed.value.length > COOKIE_VALUE_LIMIT) continue;
      const stored = await jar.setCookie(raw, url.href, { ignoreError: true });
      if (!this.isGenerationCurrent(expectedGeneration)) throw new ClassicApiError('AUTH_REQUIRED', 'Classic 会话已改变，请重新读取。', { scope: 'session.cookies', retryable: false });
      const expiresAt = parsed.expiryTime();
      const deleted = parsed.maxAge === 0 || parsed.maxAge === '-Infinity' || (expiresAt !== undefined && Number.isFinite(expiresAt) && expiresAt <= Date.now());
      if (deleted) {
        try {
          // tough-cookie stores an expired Set-Cookie as a tombstone. Remove
          // the exact canonical name/domain/path tuple so the mirror cannot
          // retain a deleted cookie for a later refresh.
          if (stored?.domain && stored.path && stored.key) {
            await jar.store.removeCookie(stored.domain, stored.path, stored.key);
          }
        } catch {
          /* Continue with the authoritative Electron deletion. */
        }
        try {
          if (!this.isGenerationCurrent(expectedGeneration)) throw new ClassicApiError('AUTH_REQUIRED', 'Classic 会话已改变，请重新读取。', { scope: 'session.cookies', retryable: false });
          const removalCookie = stored ?? parsed;
          await this.electronSession.cookies.remove(cookieRemovalUrl(url, removalCookie), removalCookie.key);
        } catch (error) {
          if (error instanceof ClassicApiError) throw error;
          /* Diagnostics and cleanup are best effort. */
        }
        continue;
      }
      if (!stored) continue;
      const details = cookieToElectron(stored, url);
      if (!details) continue;
      try {
        if (!this.isGenerationCurrent(expectedGeneration)) throw new ClassicApiError('AUTH_REQUIRED', 'Classic 会话已改变，请重新读取。', { scope: 'session.cookies', retryable: false });
        await this.electronSession.cookies.set(details);
      } catch (error) {
        if (error instanceof ClassicApiError) throw error;
        /* Keep the in-memory jar; the next request remains bounded. */
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.authFlight = undefined;
    this.advance('unauthenticated');
    await this.loginController?.close().catch(() => {});
    this.loginController = undefined;
    await this.flushCookieStore('close');
    debugLog.event('classic.api.session.closed', { generation: this.generationValue });
  }

  private async flushCookieStore(reason: 'login' | 'restore' | 'close'): Promise<void> {
    try {
      await this.electronSession.cookies.flushStore();
      debugLog.event('classic.api.session.cookies.flushed', { reason });
    } catch (error) {
      debugLog.error('classic.api.session.cookies.flush-error', error, { reason });
    }
  }

  private async refreshFromElectron(signal: AbortSignal, expectedGeneration?: number): Promise<void> {
    const jar = this.jar;
    const cookies = await this.electronSession.cookies.get({ url: this.origin });
    abortIfNeeded(signal);
    for (const cookie of cookies) {
      if (expectedGeneration !== undefined && !this.isGenerationCurrent(expectedGeneration)) throw new ClassicApiError('AUTH_REQUIRED', 'Classic 会话已改变，请重新读取。', { scope: 'session.cookies', retryable: false });
      const parsed = asCookie(cookie);
      if (!parsed || !parsed.value) continue;
      const sameSite = new Cookie({
        key: parsed.name,
        value: parsed.value,
        domain: parsed.domain,
        path: parsed.path,
        secure: parsed.secure,
        httpOnly: parsed.httpOnly,
        hostOnly: parsed.hostOnly,
        sameSite: parsed.sameSite === 'no_restriction' ? 'none' : parsed.sameSite,
        expires: parsed.expiresAt === null ? 'Infinity' : new Date(parsed.expiresAt),
      });
      await jar.setCookie(sameSite, this.origin, { ignoreError: true });
      if (expectedGeneration !== undefined && !this.isGenerationCurrent(expectedGeneration)) {
        throw new ClassicApiError('AUTH_REQUIRED', 'Classic 会话已改变，请重新读取。', { scope: 'session.cookies', retryable: false });
      }
    }
  }
}

export function classicPartition(profileId: string): string { return partitionFor(profileId); }

