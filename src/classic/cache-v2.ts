import { createHash } from 'node:crypto';
import { debugLog } from '../debug-log.js';
import { vault } from '../vault.js';
import { ClassicApiError } from './api-errors.js';
import { CLASSIC_API_ORIGIN } from './api-contract.js';
import { SnapshotV2Schema, type AnnouncementV2, type AssignmentV2, type CourseFileV2, type SnapshotV2 } from './schema-v2.js';

export interface ClassicCacheIdentity {
  readonly profileId: string;
  readonly origin: string;
  readonly userId: string;
  readonly source: SnapshotV2['source'];
  readonly sessionGeneration: number;
}

interface CacheEnvelope {
  schemaVersion: 2;
  identity: Omit<ClassicCacheIdentity, 'sessionGeneration'> & { sessionGeneration: number };
  snapshot: SnapshotV2;
}

interface CacheFile {
  version: 2;
  entries: Record<string, CacheEnvelope>;
}

export interface ClassicProtectedCacheStore {
  read(): Promise<CacheFile | null>;
  write(value: CacheFile): Promise<void>;
  /**
   * Atomically transforms the protected file when the backing store supports
   * it.  The callback must not perform I/O; this keeps account scopes from
   * losing an update when two renderer actions finish together.
   */
  update?(change: (previous: CacheFile | null) => CacheFile): Promise<void>;
}

const CACHE_SLOT = 'classic:snapshots-v2';
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const CACHE_PROFILE = {
  id: 'cuhksz',
  label: 'CUHK(SZ) Classic cache',
  timezone: 'Asia/Shanghai',
  blackboard: CLASSIC_API_ORIGIN,
} as const;

function cacheKey(identity: Omit<ClassicCacheIdentity, 'sessionGeneration'>): string {
  return createHash('sha256').update(JSON.stringify([identity.profileId, identity.origin, identity.userId, identity.source, 2])).digest('hex');
}

function identityWithoutGeneration(identity: ClassicCacheIdentity): Omit<ClassicCacheIdentity, 'sessionGeneration'> {
  const { sessionGeneration: _generation, ...scope } = identity;
  return scope;
}

function emptyFile(): CacheFile { return { version: 2, entries: {} }; }

function validIdentity(identity: ClassicCacheIdentity): void {
  if (
    typeof identity.profileId !== 'string' || identity.profileId.trim().length === 0 || identity.profileId.length > 300 ||
    identity.origin !== CLASSIC_API_ORIGIN ||
    typeof identity.userId !== 'string' || identity.userId.trim().length === 0 || identity.userId.length > 300 ||
    (identity.source !== 'live' && identity.source !== 'offline-fixture') ||
    !Number.isInteger(identity.sessionGeneration) || identity.sessionGeneration < 0 || identity.sessionGeneration > 1_000_000_000
  ) {
    throw new ClassicApiError('BAD_INPUT', 'Classic 缓存账户上下文无效。', { scope: 'cache-v2.identity', retryable: false });
  }
}

function parsedIdentity(value: unknown): CacheEnvelope['identity'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid cache identity');
  const item = value as Record<string, unknown>;
  const identity = {
    profileId: item.profileId,
    origin: item.origin,
    userId: item.userId,
    source: item.source,
    sessionGeneration: item.sessionGeneration,
  } as ClassicCacheIdentity;
  validIdentity(identity);
  return identity;
}

function validateFile(value: unknown): CacheFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid cache root');
  const root = value as Record<string, unknown>;
  if (root.version !== 2 || !root.entries || typeof root.entries !== 'object' || Array.isArray(root.entries)) throw new Error('unsupported cache version');
  const entries: Record<string, CacheEnvelope> = {};
  for (const [key, entry] of Object.entries(root.entries as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid cache entry');
    const envelope = entry as Record<string, unknown>;
    if (envelope.schemaVersion !== 2 || !envelope.identity || !envelope.snapshot) throw new Error('invalid cache entry envelope');
    const identity = parsedIdentity(envelope.identity);
    const expectedKey = cacheKey({ profileId: identity.profileId, origin: identity.origin, userId: identity.userId, source: identity.source });
    if (key !== expectedKey) throw new Error('cache entry identity mismatch');
    entries[key] = { schemaVersion: 2, identity, snapshot: SnapshotV2Schema.parse(envelope.snapshot) };
  }
  return { version: 2, entries };
}

/** Reuses the audited Vault/OS keychain path; no plaintext snapshot fallback. */
class VaultClassicProtectedCacheStore implements ClassicProtectedCacheStore {
  async read(): Promise<CacheFile | null> {
    const stored = await vault.read<unknown>(CACHE_PROFILE, CACHE_SLOT);
    return stored?.value === undefined ? null : validateFile(stored.value);
  }

  async write(value: CacheFile): Promise<void> {
    await vault.write(CACHE_PROFILE, CACHE_SLOT, value);
  }

  async update(change: (previous: CacheFile | null) => CacheFile): Promise<void> {
    await vault.update<CacheFile>(CACHE_PROFILE, CACHE_SLOT, previous => {
      const current = previous === null ? null : validateFile(previous);
      return validateFile(change(current));
    });
  }
}

function markStale(snapshot: SnapshotV2): SnapshotV2 {
  return SnapshotV2Schema.parse({
    ...snapshot,
    announcements: snapshot.announcements.map(item => ({ ...item, provenance: { ...item.provenance, stale: true } })),
    assignments: snapshot.assignments.map(item => ({ ...item, provenance: { ...item.provenance, stale: true } })),
    files: snapshot.files.map(item => ({ ...item, provenance: { ...item.provenance, stale: true } })),
  });
}

function staleItem<T extends { provenance: { stale: boolean } }>(item: T): T {
  return { ...item, provenance: { ...item.provenance, stale: true } } as T;
}

type ResourceSection = 'announcements' | 'assignments' | 'files';

function scopeHasCourse(scope: string, courseId: string): boolean {
  const escaped = courseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[:/])${escaped}(?:$|[:/])`).test(scope);
}

function hasErrorFor(errors: SnapshotV2['errors'], section: ResourceSection, courseId: string): boolean {
  return errors.some(error => {
    if (!(error.scope === 'snapshot' || error.scope === section || error.scope === `snapshot:${section}` || error.scope === `course:${courseId}:${section}` || error.scope === `${section}:${courseId}`)) return false;
    return true;
  });
}

function coverageNeedsFallback(snapshot: SnapshotV2, section: ResourceSection, courseId: string): boolean {
  const entries = snapshot.coverage.filter(item => item.resource === section && (item.courseId === null || item.courseId === courseId));
  if (entries.some(item => item.state === 'failed' || item.state === 'unsupported' || item.state === 'partial' || item.truncated)) return true;
  // If memberships itself is incomplete, a previous course may simply have
  // had no chance to receive a section entry this round. Preserve it as stale
  // until the account's complete course index is known.
  return entries.length === 0 && (hasErrorFor(snapshot.errors, section, courseId) || membershipsIncomplete(snapshot));
}

function restrictedCourse(snapshot: SnapshotV2, courseId: string): boolean {
  if (snapshot.errors.some(error => (error.code === 'FORBIDDEN' || error.code === 'CONTENT_UNAVAILABLE') && scopeHasCourse(error.scope, courseId))) return true;
  // A restricted content subtree is represented in coverage even when the
  // transport error scope is generic (for example pagination:contents).
  return snapshot.coverage.some(entry => entry.courseId === courseId && entry.restrictedNodes > 0);
}

function membershipsIncomplete(snapshot: SnapshotV2): boolean {
  const entries = snapshot.coverage.filter(item => item.resource === 'courses' && item.courseId === null);
  return entries.length === 0 || entries.some(item => item.state !== 'complete' || item.truncated);
}

function mergeResource<T extends { id: string; courseId: string; provenance: { stale: boolean } }>(current: T[], previous: T[], canFallback: (item: T) => boolean): { items: T[]; used: boolean } {
  const ids = new Set(current.map(item => `${item.courseId}\0${item.id}`));
  const additions = previous
    .filter(item => canFallback(item) && !ids.has(`${item.courseId}\0${item.id}`))
    .map(item => staleItem(item));
  return { items: [...current, ...additions], used: additions.length > 0 };
}

function mergeCourses(current: SnapshotV2['courses'], previous: SnapshotV2['courses']): SnapshotV2['courses'] {
  const ids = new Set(current.map(item => item.id));
  return [...current, ...previous.filter(item => !ids.has(item.id))];
}

/** Resource-level stale fallback. Successful empty arrays and removed memberships stay empty. */
export function mergeSnapshotV2WithCache(current: SnapshotV2, previous: SnapshotV2 | undefined): SnapshotV2 {
  if (!previous) return current;
  const allowOldCourses = membershipsIncomplete(current);
  const activeCourses = new Set(current.courses.map(item => item.id));
  const canUsePreviousItem = (section: ResourceSection, item: { courseId: string }): boolean => {
    if (!allowOldCourses && !activeCourses.has(item.courseId)) return false;
    if (restrictedCourse(current, item.courseId)) return false;
    return coverageNeedsFallback(current, section, item.courseId);
  };
  const announcements = mergeResource(current.announcements, previous.announcements, item => canUsePreviousItem('announcements', item));
  const assignments = mergeResource(current.assignments, previous.assignments, item => canUsePreviousItem('assignments', item));
  const files = mergeResource(current.files, previous.files, item => canUsePreviousItem('files', item));
  const courses = allowOldCourses ? mergeCourses(current.courses, previous.courses) : current.courses;
  const used = announcements.used || assignments.used || files.used || courses.length > current.courses.length;
  if (!used) return current;
  const errors = [...current.errors, { scope: 'cache', code: 'CACHE_FALLBACK', message: '部分 Classic API 读取失败，已保留对应账户的上次数据。' }];
  return SnapshotV2Schema.parse({
    ...current,
    state: current.state === 'ok' ? 'partial' : current.state,
    courses,
    announcements: announcements.items,
    assignments: assignments.items,
    files: files.items,
    errors,
  });
}

export interface ClassicSnapshotCacheOptions {
  readonly store?: ClassicProtectedCacheStore;
  readonly maxAgeMs?: number;
}

export class ClassicSnapshotV2Cache {
  private readonly store: ClassicProtectedCacheStore;
  private readonly maxAgeMs: number;

  constructor(options: ClassicSnapshotCacheOptions = {}) {
    this.store = options.store ?? new VaultClassicProtectedCacheStore();
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  private async readFile(): Promise<CacheFile> {
    try {
      return (await this.store.read()) ?? emptyFile();
    } catch (error) {
      if (error instanceof ClassicApiError && error.code === 'CACHE_FALLBACK') throw error;
      throw new ClassicApiError('CACHE_FALLBACK', 'Classic v2 缓存无法读取；原受保护文件未覆盖。', { scope: 'cache-v2.read', stale: true, cause: error });
    }
  }

  async read(identity: ClassicCacheIdentity): Promise<SnapshotV2 | undefined> {
    validIdentity(identity);
    const all = await this.readFile();
    const entry = all.entries[cacheKey(identityWithoutGeneration(identity))];
    if (!entry) return undefined;
    const fetchedAt = Date.parse(entry.snapshot.fetchedAt);
    const tooOld = !Number.isFinite(fetchedAt) || Date.now() - fetchedAt > this.maxAgeMs;
    const stale = entry.identity.sessionGeneration !== identity.sessionGeneration || tooOld;
    const snapshot = stale ? markStale(entry.snapshot) : structuredClone(entry.snapshot);
    debugLog.event('classic.cache-v2.read', { hit: true, stale, tooOld, source: identity.source, userIdPresent: true });
    return snapshot;
  }

  async write(identity: ClassicCacheIdentity, snapshot: SnapshotV2, guard?: () => void): Promise<void> {
    validIdentity(identity);
    const parsed = SnapshotV2Schema.parse(snapshot);
    const scope = identityWithoutGeneration(identity);
    try {
      guard?.();
      if (this.store.update) {
        await this.store.update(previous => {
          const all = previous === null ? emptyFile() : validateFile(previous);
          all.entries[cacheKey(scope)] = { schemaVersion: 2, identity: { ...scope, sessionGeneration: identity.sessionGeneration }, snapshot: parsed };
          guard?.();
          return all;
        });
      } else {
        const all = await this.readFile();
        all.entries[cacheKey(scope)] = { schemaVersion: 2, identity: { ...scope, sessionGeneration: identity.sessionGeneration }, snapshot: parsed };
        guard?.();
        await this.store.write(all);
      }
      guard?.();
    } catch (error) {
      if (error instanceof ClassicApiError && ['CACHE_FALLBACK', 'SESSION_EXPIRED', 'AUTH_REQUIRED', 'TIMEOUT'].includes(error.code)) throw error;
      throw new ClassicApiError('CACHE_FALLBACK', 'Classic v2 缓存无法保存；本次数据仍可继续查看。', { scope: 'cache-v2.write', stale: true, cause: error });
    }
    debugLog.event('classic.cache-v2.write', { source: identity.source, userIdPresent: true, courseCount: parsed.courses.length });
  }
}

export type { CacheFile };
