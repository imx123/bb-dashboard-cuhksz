import type { Profile } from '../config.js';
import { ClassicApiError, publicApiError, type PublicClassicApiError } from './api-errors.js';
import type { ClassicApiTransport, ClassicSession as ClassicSessionContract, ClassicSessionSnapshot } from './api-contract.js';
import { ClassicApiClient } from './api-client.js';
import { createRequestBudget } from './pagination.js';
import { readClassicSnapshot } from './api-snapshot.js';
import { readAssignmentDetail, type AssignmentDetailResult, type ClassicCachedResource, type ClassicResourceRegistrar } from './detail-reader.js';
import { ClassicSnapshotV2Cache, mergeSnapshotV2WithCache, type ClassicCacheIdentity } from './cache-v2.js';
import { SnapshotV2Schema, type AssignmentV2, type SnapshotV2 } from './schema-v2.js';

export interface ClassicApiProviderOptions {
  readonly profile?: Pick<Profile, 'id' | 'blackboard'>;
  readonly profileId?: string;
  readonly origin?: string;
  readonly source?: SnapshotV2['source'];
  readonly session?: ClassicSessionContract;
  readonly transport?: ClassicApiTransport;
  readonly api?: ClassicApiClient;
  readonly cache?: ClassicSnapshotV2Cache;
  readonly resourceRegistry?: ClassicResourceRegistrar;
}

export interface ClassicApiProviderStatus {
  readonly ok: boolean;
  readonly session: ClassicSessionSnapshot;
  readonly error?: PublicClassicApiError;
}

function accountIdentity(session: ClassicSessionContract, source: SnapshotV2['source']): ClassicCacheIdentity {
  const account = session.account;
  if (!account) throw new ClassicApiError('AUTH_REQUIRED', 'Classic 会话缺少当前账户。', { scope: 'provider.identity', retryable: false });
  return { profileId: account.profileId, origin: account.origin, userId: account.userId, source, sessionGeneration: account.sessionGeneration };
}

function sameIdentity(left: ClassicCacheIdentity, right: ClassicCacheIdentity): boolean {
  return left.profileId === right.profileId && left.origin === right.origin && left.userId === right.userId &&
    left.source === right.source && left.sessionGeneration === right.sessionGeneration;
}

function cancelled(scope: string): ClassicApiError {
  return new ClassicApiError('TIMEOUT', 'Classic 操作已取消。', { scope, retryable: false });
}

function addCacheError(snapshot: SnapshotV2, error: unknown): SnapshotV2 {
  const publicError = publicApiError(error);
  return SnapshotV2Schema.parse({
    ...snapshot,
    state: snapshot.state === 'ok' ? 'partial' : snapshot.state,
    errors: [...snapshot.errors, { scope: publicError.scope || 'cache', code: publicError.code, message: '本机缓存未能读取，已继续使用本次 API 结果。' }],
  });
}

function collectResourceIds(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectResourceIds(item, output);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'resourceId' && typeof child === 'string') output.add(child);
    else collectResourceIds(child, output);
  }
  return output;
}

const OPAQUE_RESOURCE_ID = /^[A-Za-z0-9._:-]{1,300}$/;
const OPAQUE_RESOURCE_SRC = /((?:^|[\s<])src\s*=\s*)(["'])(lms-resource:\/\/resource\/)([A-Za-z0-9._:-]{1,300})(\2)/g;

function remapOpaqueResourceHtml(value: string, mapping: ReadonlyMap<string, string>): { html: string; unresolved: boolean } {
  let unresolved = false;
  OPAQUE_RESOURCE_SRC.lastIndex = 0;
  const html = value.replace(OPAQUE_RESOURCE_SRC, (whole, prefix: string, quote: string, scheme: string, oldResourceId: string) => {
    const mappedResourceId = mapping.get(oldResourceId);
    if (!mappedResourceId || !OPAQUE_RESOURCE_ID.test(mappedResourceId)) {
      unresolved = true;
      return whole;
    }
    return `${prefix}${quote}${scheme}${encodeURIComponent(mappedResourceId)}${quote}`;
  });
  return { html, unresolved };
}

function remapResourceIds<T>(value: T, mapping: ReadonlyMap<string, string>): T {
  if (Array.isArray(value)) return value.map(item => remapResourceIds(item, mapping)) as T;
  if (!value || typeof value !== 'object') return value;
  const originalImages = Array.isArray((value as Record<string, unknown>).images) ? (value as Record<string, unknown>).images : undefined;
  let opaqueHtmlUnresolved = false;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'resourceId' && typeof child === 'string') output[key] = mapping.get(child) ?? child;
    else if (key === 'sanitizedHtml' && typeof child === 'string') {
      const remapped = remapOpaqueResourceHtml(child, mapping);
      output[key] = remapped.html;
      opaqueHtmlUnresolved ||= remapped.unresolved;
    } else output[key] = remapResourceIds(child, mapping);
  }
  if (Array.isArray(originalImages) && typeof output.complete === 'boolean') {
    const unresolved = originalImages.some(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).resourceId === 'string' && !mapping.has((item as Record<string, unknown>).resourceId as string));
    if (unresolved || opaqueHtmlUnresolved) output.complete = false;
  } else if (opaqueHtmlUnresolved && typeof output.complete === 'boolean') {
    output.complete = false;
  }
  return output as T;
}

function cachedResourceContexts(registry: ClassicResourceRegistrar | undefined, snapshot: SnapshotV2): readonly ClassicCachedResource[] {
  const ids = [...collectResourceIds(snapshot)];
  return registry?.snapshotCachedResources?.(ids) ?? [];
}

/** New production provider boundary. It never imports or falls back to MCP. */
export class ClassicApiProvider {
  readonly session: ClassicSessionContract;
  readonly api: ClassicApiClient;
  readonly cache: ClassicSnapshotV2Cache;
  readonly source: SnapshotV2['source'];
  private readonly resourceRegistry?: ClassicResourceRegistrar;
  private last?: SnapshotV2;
  private lastIdentity?: ClassicCacheIdentity;
  private activeLoad?: Promise<SnapshotV2>;
  private activeController?: AbortController;
  private activeLoadScope?: { userId: string | null; generation: number };
  private readonly activeControllers = new Set<AbortController>();

  constructor(options: ClassicApiProviderOptions = {}) {
    this.source = options.source ?? 'live';
    if (options.api) {
      this.api = options.api;
      if (!options.session) throw new ClassicApiError('BAD_INPUT', 'Classic API provider 缺少 session。', { scope: 'provider.init', retryable: false });
      this.session = options.session;
    } else {
      // Session/HTTP construction belongs to the Electron main factory.  The
      // core provider stays importable by offline fixtures and never pulls an
      // Electron module merely because a test or CLI imports this file.
      if (!options.session || !options.transport) throw new ClassicApiError('BAD_INPUT', 'Classic API provider 需要由主进程注入 session/transport。', { scope: 'provider.init', retryable: false });
      this.session = options.session;
      this.api = new ClassicApiClient({ transport: options.transport, session: this.session });
    }
    this.cache = options.cache ?? new ClassicSnapshotV2Cache();
    this.resourceRegistry = options.resourceRegistry;
  }

  get snapshot(): SnapshotV2 | undefined {
    const account = this.session.account;
    if (!this.last || !this.lastIdentity || !account) return undefined;
    const current: ClassicCacheIdentity = { profileId: account.profileId, origin: account.origin, userId: account.userId, source: this.source, sessionGeneration: account.sessionGeneration };
    return sameIdentity(this.lastIdentity, current) ? structuredClone(this.last) : undefined;
  }

  async status(_signal = new AbortController().signal, _traceId?: string): Promise<ClassicApiProviderStatus> {
    // Status is a local snapshot.  Explicit completeLogin/load performs the
    // bounded identity request; merely rendering the status panel must not
    // probe the school or mutate an existing session generation.
    const session = { state: this.session.state, account: this.session.account, generation: this.session.generation } satisfies ClassicSessionSnapshot;
    if (session.state === 'authenticated' && session.account) return { ok: true, session };
    const code = session.state === 'expired' ? 'SESSION_EXPIRED' : session.state === 'unauthenticated' ? 'AUTH_REQUIRED' : 'TIMEOUT';
    const message = code === 'SESSION_EXPIRED' ? 'Classic 会话已过期。' : code === 'AUTH_REQUIRED' ? '请先完成 Blackboard 登录。' : '会话检查尚未完成，请重试。';
    return { ok: false, session: { ...session, errorCode: code }, error: publicApiError(new ClassicApiError(code, message, { scope: 'provider.status', retryable: code === 'TIMEOUT' })) };
  }

  async beginLogin(signal?: AbortSignal, traceId?: string): Promise<ClassicSessionSnapshot> {
    return this.session.beginLogin(signal, traceId);
  }

  async completeLogin(signal?: AbortSignal, traceId?: string): Promise<ClassicSessionSnapshot> {
    return this.session.completeLogin(signal, traceId);
  }

  async load(signal = new AbortController().signal, traceId?: string): Promise<SnapshotV2> {
    if (this.activeLoad) {
      const account = this.session.account;
      const scope = { userId: account?.userId ?? null, generation: account?.sessionGeneration ?? this.session.generation };
      if (!this.activeLoadScope || (this.activeLoadScope.userId === scope.userId && this.activeLoadScope.generation === scope.generation)) return this.activeLoad;
      this.cancel();
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) controller.abort(signal.reason); else signal.addEventListener('abort', abort, { once: true });
    this.activeController = controller;
    const account = this.session.account;
    this.activeLoadScope = { userId: account?.userId ?? null, generation: account?.sessionGeneration ?? this.session.generation };
    this.activeControllers.add(controller);
    this.activeLoad = this.read(controller.signal, traceId).finally(() => {
      signal.removeEventListener('abort', abort);
      this.activeControllers.delete(controller);
      // A generation switch can start a replacement load before the old
      // promise settles. The old cleanup must not clear the replacement's
      // singleflight/controller references.
      if (this.activeController === controller) {
        this.activeController = undefined;
        this.activeLoadScope = undefined;
        this.activeLoad = undefined;
      }
    });
    return this.activeLoad;
  }

  private async read(signal: AbortSignal, traceId?: string): Promise<SnapshotV2> {
    // Keep enough request slots for the final identity check and its bounded
    // network retries; ordinary course reads must stop before this reserve.
    const budget = createRequestBudget(signal, { deadlineMs: 90_000, requestLimit: 300, reserveRequests: 3, reserveMs: 15_000 });
    // Login completion owns the explicit identity/membership probe.  A load
    // reuses that confirmed context and lets the bounded snapshot requests
    // (including the first and final identity reads) detect expiry.  Calling
    // ensureAuthenticated here would start a separate short auth budget
    // outside the documented 300-request sync budget.
    const state = this.session.state;
    if (state !== 'authenticated' || !this.session.account) {
      const code = state === 'expired' ? 'SESSION_EXPIRED' : state === 'unknown' ? 'TIMEOUT' : 'AUTH_REQUIRED';
      const message = code === 'SESSION_EXPIRED' ? 'Classic 会话已过期。' : code === 'TIMEOUT' ? '会话检查尚未完成，请重试。' : '请先完成 Blackboard 登录。';
      throw new ClassicApiError(code, message, { scope: 'provider.load', retryable: code === 'TIMEOUT' });
    }
    const identity = accountIdentity(this.session, this.source);
    const guard = () => {
      if (signal.aborted) throw cancelled('provider.load.cancel');
      const current = accountIdentity(this.session, this.source);
      if (!sameIdentity(identity, current)) throw new ClassicApiError('SESSION_EXPIRED', 'Classic 会话在同步期间发生变化，本次结果已丢弃。', { scope: 'provider.generation', retryable: false });
    };
    let previous: SnapshotV2 | undefined;
    let cacheFailure: unknown;
    try {
      const cached = await this.cache.readWithResources(identity);
      guard();
      previous = cached?.snapshot;
      if (previous && this.resourceRegistry?.restoreCachedResources) {
        const remapped = this.resourceRegistry.restoreCachedResources(cached?.resources ?? []);
        previous = remapResourceIds(previous, remapped);
        guard();
      }
    } catch (error) {
      if (error instanceof ClassicApiError && ['SESSION_EXPIRED', 'AUTH_REQUIRED', 'TIMEOUT'].includes(error.code)) throw error;
      cacheFailure = error;
    }
    const result = await readClassicSnapshot(this.api, { signal, traceId, budget, source: this.source, resourceRegistry: this.resourceRegistry });
    guard();
    let snapshot = previous ? mergeSnapshotV2WithCache(result.snapshot, previous) : result.snapshot;
    if (cacheFailure) snapshot = addCacheError(snapshot, cacheFailure);
    try { await this.cache.write(identity, snapshot, guard, cachedResourceContexts(this.resourceRegistry, snapshot)); }
    catch (error) {
      if (error instanceof ClassicApiError && ['SESSION_EXPIRED', 'AUTH_REQUIRED', 'TIMEOUT'].includes(error.code)) throw error;
      snapshot = addCacheError(snapshot, error);
    }
    guard();
    this.last = snapshot;
    this.lastIdentity = identity;
    return snapshot;
  }

  async detail(assignment: AssignmentV2, signal = new AbortController().signal, traceId?: string): Promise<AssignmentDetailResult> {
    const identity = accountIdentity(this.session, this.source);
    if (!this.lastIdentity || !sameIdentity(this.lastIdentity, identity)) throw new ClassicApiError('SESSION_EXPIRED', '当前作业快照不属于当前 Classic 账号。', { scope: 'provider.detail.generation', retryable: false });
    const current = this.last?.assignments.find(item => item.courseId === assignment.courseId && item.id === assignment.id);
    if (!current) throw new ClassicApiError('NOT_FOUND', '作业不在当前 Classic 快照中。', { scope: 'provider.detail', retryable: false });
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) controller.abort(signal.reason); else signal.addEventListener('abort', abort, { once: true });
    this.activeControllers.add(controller);
    const budget = createRequestBudget(controller.signal, { deadlineMs: 90_000, requestLimit: 48 });
    try {
      const result = await readAssignmentDetail(this.api, current, { signal: controller.signal, traceId, budget, resourceRegistry: this.resourceRegistry });
      const currentIdentity = accountIdentity(this.session, this.source);
      if (!sameIdentity(identity, currentIdentity)) throw new ClassicApiError('SESSION_EXPIRED', 'Classic 会话在读取作业详情期间发生变化。', { scope: 'provider.detail.generation', retryable: false });
      return result;
    } finally {
      signal.removeEventListener('abort', abort);
      this.activeControllers.delete(controller);
    }
  }

  cancel(): void {
    const reason = cancelled('provider.cancel');
    for (const controller of this.activeControllers) controller.abort(reason);
    this.activeController?.abort(reason);
  }

  async close(): Promise<void> { this.cancel(); await this.session.close(); }
}
