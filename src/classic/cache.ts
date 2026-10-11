import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite, ensureHome, stateHome } from '../config.js';
import { debugLog } from '../debug-log.js';
import { ClassicError } from './errors.js';
import { SnapshotSchema, type Snapshot } from './schema.js';

type CacheFile = Record<string, Snapshot>;

function key(scope: string): string {
  return createHash('sha256').update(scope).digest('hex');
}

export class ClassicSnapshotCache {
  constructor(private readonly file = join(stateHome(), 'classic-snapshots.json')) {}

  private async readAll(): Promise<CacheFile> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid cache root');
      const entries: CacheFile = {};
      for (const [scope, snapshot] of Object.entries(value)) entries[scope] = SnapshotSchema.parse(snapshot);
      return entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new ClassicError('CACHE_READ_FAILED', '本机缓存无法读取，已跳过旧数据。', { cause: error });
    }
  }

  async read(scope: string): Promise<Snapshot | undefined> {
    const cacheKey = key(scope);
    const value = (await this.readAll())[cacheKey];
    debugLog.event('classic.cache.read', { hit: Boolean(value), cacheKey: cacheKey.slice(0, 12) });
    return value ? structuredClone(value) : undefined;
  }

  async write(scope: string, snapshot: Snapshot): Promise<void> {
    const parsed = SnapshotSchema.parse(snapshot);
    try {
      await ensureHome();
      const all = await this.readAll().catch(() => ({} as CacheFile));
      all[key(scope)] = parsed;
      await atomicWrite(this.file, JSON.stringify(all));
      debugLog.event('classic.cache.write', {
        courseCount: parsed.courses.length,
        announcementCount: parsed.announcements.length,
        assignmentCount: parsed.assignments.length,
        fileCount: parsed.files.length,
      });
    } catch (error) {
      debugLog.error('classic.cache.write.error', error);
      if (error instanceof ClassicError && error.code === 'CACHE_WRITE_FAILED') throw error;
      throw new ClassicError('CACHE_WRITE_FAILED', '本机缓存无法保存；本次数据仍可继续查看。', { cause: error });
    }
  }
}

type ResourceSection = 'announcements' | 'assignments' | 'files';
type SectionFailure = { global: boolean; courses: Set<string> };

function sectionFailure(errors: Snapshot['errors'], section: ResourceSection): SectionFailure {
  const failure: SectionFailure = { global: false, courses: new Set<string>() };
  for (const error of errors) {
    const scope = error.scope;
    if (scope === 'snapshot' || scope === section || scope === `snapshot:${section}`) {
      failure.global = true;
      continue;
    }
    const course = /^course:(_\d+_\d+):([^:]+)$/.exec(scope);
    if (course?.[2] === section) {
      failure.courses.add(course[1]!);
      continue;
    }
    // Keep compatibility with adapters that used `announcements:<course>`
    // while still distinguishing a course-specific failure from a global one.
    if (scope.startsWith(`${section}:`)) {
      const remainder = scope.slice(section.length + 1);
      const courseId = /^(_\d+_\d+)(?::|$)/.exec(remainder)?.[1];
      if (courseId) failure.courses.add(courseId);
      else failure.global = true;
    }
  }
  return failure;
}

function mergeItems<T extends { id: string }>(currentItems: T[], previousItems: T[], shouldFallback: (item: T) => boolean): { items: T[]; used: boolean } {
  const currentIds = new Set(currentItems.map(item => item.id));
  const additions = previousItems.filter(item => shouldFallback(item) && !currentIds.has(item.id));
  return { items: [...currentItems, ...additions], used: additions.length > 0 };
}

/** Keep only the failed course's previous resources. Empty successful courses
 * remain empty, so a deleted announcement/file is never resurrected by a
 * different course's failure. */
export function mergeSnapshotWithCache(current: Snapshot, previous: Snapshot | undefined): Snapshot {
  if (!previous) return current;
  const courseFailure = current.errors.some(error => error.scope === 'snapshot' || error.scope === 'courses');
  const announcementsFailure = sectionFailure(current.errors, 'announcements');
  const assignmentsFailure = sectionFailure(current.errors, 'assignments');
  const filesFailure = sectionFailure(current.errors, 'files');
  let usedFallback = false;
  const courseItems = courseFailure ? mergeItems(current.courses, previous.courses, () => true) : { items: current.courses, used: false };
  const announcements = mergeItems(current.announcements, previous.announcements, item => announcementsFailure.global || announcementsFailure.courses.has(item.courseId));
  const assignments = mergeItems(current.assignments, previous.assignments, item => assignmentsFailure.global || assignmentsFailure.courses.has(item.courseId));
  const files = mergeItems(current.files, previous.files, item => filesFailure.global || filesFailure.courses.has(item.courseId));
  usedFallback = courseItems.used || announcements.used || assignments.used || files.used;
  const merged = {
    ...current,
    courses: courseItems.items,
    announcements: announcements.items,
    assignments: assignments.items,
    files: files.items,
    errors: [...current.errors],
  } satisfies Snapshot;
  if (usedFallback) {
    merged.errors.push({ scope: 'cache', code: 'CACHE_FALLBACK', message: `部分内容读取失败，已保留上次成功读取的数据（上次同步：${previous.fetchedAt}）。` });
    if (merged.state === 'ok') merged.state = 'partial';
  }
  return SnapshotSchema.parse(merged);
}
