import { ClassicSnapshotCache, mergeSnapshotWithCache } from './cache.js';
import { parseSnapshotResult, parseStatusResult, errorEntry, makeSnapshot } from './adapter.js';
import { ClassicError, errorCode, publicClassicError } from './errors.js';
import { classicUserDataDir, ClassicMcpClient } from './mcp-client.js';
import { debugLog } from '../debug-log.js';
import type { Assignment, AuthResult, Snapshot } from './schema.js';

export interface ClassicProviderOptions {
  client?: ClassicMcpClient;
  cache?: ClassicSnapshotCache;
  scope?: string;
  source?: 'live' | 'offline-fixture';
  /** Trusted main-process override; live defaults to a scope-derived path. */
  userDataDir?: string;
  maxCourses?: number;
}

function isAuth(error: unknown): boolean {
  return error instanceof ClassicError && (error.code === 'AUTH_REQUIRED' || error.code === 'SESSION_EXPIRED');
}

function statusError(error: { code: string; message: string; scope?: string }, authResult?: AuthResult): ReturnType<typeof publicClassicError> {
  const scope = error.scope || 'auth';
  let message = error.message.slice(0, 240);
  if (authResult) {
    const origin = authResult.origin ?? 'unknown';
    const pathname = authResult.pathname ?? 'unknown';
    message = `${message}（scope=${scope}; phase=${authResult.phase}; origin=${origin}; pathname=${pathname}; portalCandidate=${authResult.portalCandidate ? 'true' : 'false'}; courseLinks=${authResult.courseLinkCount}; marker=${authResult.marker ? 'true' : 'false'}; iframeCount=${authResult.iframeCount}; loginForm=${authResult.explicitLoginForm ? 'true' : 'false'}; sessionExpired=${authResult.sessionExpired ? 'true' : 'false'}）`.slice(0, 500);
  } else {
    message = `${message}（scope=${scope}）`.slice(0, 500);
  }
  return publicClassicError(new ClassicError(errorCode(error.code), message));
}

function dateOnlyInShanghai(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function filterAssignments(assignments: Assignment[], days: number, now = new Date()): Assignment[] {
  const end = new Date(now.getTime() + days * 86_400_000);
  const start = new Date(now.getTime() - 30 * 86_400_000);
  const endOnly = dateOnlyInShanghai(end);
  const startOnly = dateOnlyInShanghai(start);
  return assignments.filter(item => {
    if (item.dueAt) {
      const time = Date.parse(item.dueAt);
      return Number.isFinite(time) && time <= end.getTime() && time >= start.getTime();
    }
    if (item.dueDateOnly) return item.dueDateOnly >= startOnly && item.dueDateOnly <= endOnly;
    return true;
  });
}

export class ClassicProvider {
  private readonly client: ClassicMcpClient;
  private readonly cache: ClassicSnapshotCache;
  private readonly scope: string;
  private readonly source: 'live' | 'offline-fixture';
  private readonly maxCourses: number;
  private last?: Snapshot;

  constructor(options: ClassicProviderOptions = {}) {
    this.source = options.source ?? (process.env.CUHK_CLASSIC_MODE === 'offline-fixture' ? 'offline-fixture' : 'live');
    this.cache = options.cache ?? new ClassicSnapshotCache();
    this.scope = options.scope ?? `cuhksz|https://bb.cuhk.edu.cn|${this.source}`;
    const userDataDir = this.source === 'live' ? options.userDataDir ?? classicUserDataDir(this.scope) : undefined;
    this.maxCourses = options.maxCourses ?? 15;
    this.client = options.client ?? new ClassicMcpClient({ mode: this.source, userDataDir, maxCourses: this.maxCourses });
  }

  async load(days: number): Promise<Snapshot> {
    if (!Number.isInteger(days) || ![7, 14, 30].includes(days)) throw new ClassicError('BAD_INPUT', '请选择 7、14 或 30 天。', { recoverable: false });
    const started = Date.now();
    debugLog.event('classic.load.start', { days, source: this.source, maxCourses: this.maxCourses });
    const previous = this.last ?? await this.cache.read(this.scope).catch(() => undefined);
    try {
      const result = await this.client.call('classic_snapshot', {
        include: ['announcements', 'assignments', 'files'],
        limits: { announcements: 20, assignments: 100, files: 100 },
      });
      const parsed = parseSnapshotResult(result);
      const courses = parsed.courses.length > this.maxCourses ? parsed.courses.slice(0, this.maxCourses) : parsed.courses;
      const errors = parsed.courses.length > this.maxCourses
        ? [...parsed.errors, { scope: 'courses', code: 'PARTIAL_RESULTS', message: `课程较多，仅读取前 ${this.maxCourses} 门课程。` }]
        : parsed.errors;
      const snapshot = makeSnapshot({ ...parsed, courses, errors, source: this.source });
      const merged = mergeSnapshotWithCache(snapshot, previous);
      this.last = merged;
      await this.cache.write(this.scope, merged).catch(() => {});
      const output = makeSnapshot({ ...merged, assignments: filterAssignments(merged.assignments, days) });
      debugLog.event('classic.load.done', {
        elapsedMs: Date.now() - started,
        state: output.state,
        courseCount: output.courses.length,
        announcementCount: output.announcements.length,
        assignmentCount: output.assignments.length,
        fileCount: output.files.length,
        errorCount: output.errors.length,
        cacheFallback: output.errors.some(error => error.code === 'CACHE_FALLBACK'),
      });
      return output;
    } catch (error) {
      debugLog.error('classic.load.error', error, { elapsedMs: Date.now() - started });
      const snapshot = makeSnapshot({ state: isAuth(error) ? 'auth-required' : 'error', courses: [], announcements: [], assignments: [], files: [], errors: [errorEntry('snapshot', error)], source: this.source });
      const merged = mergeSnapshotWithCache(snapshot, previous);
      this.last = merged;
      const output = makeSnapshot({ ...merged, assignments: filterAssignments(merged.assignments, days) });
      debugLog.event('classic.load.partial', { elapsedMs: Date.now() - started, state: output.state, courseCount: output.courses.length, errorCount: output.errors.length });
      return output;
    }
  }

  async status(): Promise<{ ok: boolean; error?: ReturnType<typeof publicClassicError> }> {
    const started = Date.now();
    debugLog.event('classic.status.start');
    try {
      const status = parseStatusResult(await this.client.call('classic_status'));
      if (status.state === 'auth-required' || !status.authenticated) {
        const first = status.errors[0];
        throw first
          ? new ClassicError(errorCode(first.code), first.message.slice(0, 240))
          : new ClassicError(status.state === 'auth-required' ? 'AUTH_REQUIRED' : 'UPSTREAM_FAILED', status.state === 'auth-required' ? '需要在本机完成 Blackboard 登录。' : 'Blackboard 当前状态无法确认。');
      }
      if (status.state !== 'ok') {
        const first = status.errors[0];
        throw first ? new ClassicError(errorCode(first.code), first.message.slice(0, 240)) : new ClassicError('UPSTREAM_FAILED', 'Blackboard 当前状态无法确认。');
      }
      debugLog.event('classic.status.done', { elapsedMs: Date.now() - started, authenticated: true });
      return { ok: true };
    } catch (error) {
      debugLog.error('classic.status.error', error, { elapsedMs: Date.now() - started });
      return { ok: false, error: publicClassicError(error) };
    }
  }

  get snapshot(): Snapshot | undefined { return this.last; }

  async login(action: 'begin' | 'complete' = 'begin'): Promise<{ ok: boolean; state?: string; next?: string; error?: ReturnType<typeof publicClassicError> }> {
    const started = Date.now();
    debugLog.event('classic.login.start', { action });
    try {
      const status = parseStatusResult(await this.client.call('classic_login', { action }));
      const ok = status.state === 'ok' && status.authenticated;
      const first = status.errors[0];
      debugLog.event('classic.login.done', { elapsedMs: Date.now() - started, action, state: status.state, authenticated: status.authenticated, errorCode: first?.code });
      return {
        ok,
        state: status.state,
        ...(status.next ? { next: status.next } : {}),
        ...(status.authResult ? { authResult: status.authResult } : {}),
        ...(!ok && first ? { error: statusError(first, status.authResult) } : {}),
      };
    } catch (error) {
      debugLog.error('classic.login.error', error, { elapsedMs: Date.now() - started, action });
      return { ok: false, error: publicClassicError(error) };
    }
  }

  async close(): Promise<void> {
    debugLog.event('classic.close.start');
    await this.client.close();
    debugLog.event('classic.close.done');
  }
}

export { filterAssignments };
