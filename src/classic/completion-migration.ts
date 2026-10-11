import { createHash, randomUUID } from 'node:crypto';
import { copyFile, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { atomicWrite, locked, stateHome } from '../config.js';
import { ClassicApiError } from './api-errors.js';
import { CLASSIC_API_ORIGIN } from './api-contract.js';

const Id = z.string().trim().min(1).max(300);
const Key = z.string().regex(/^[a-f0-9]{64}$/);

export const CompletionScopeV2Schema = z.object({
  profileId: z.string().trim().min(1).max(300),
  origin: z.literal(CLASSIC_API_ORIGIN),
  userId: Id,
  source: z.enum(['live', 'offline-fixture']),
}).strict();
export type CompletionScopeV2 = z.infer<typeof CompletionScopeV2Schema>;

export const CompletionMarkV2Schema = z.object({
  key: Key,
  completed: z.boolean(),
  createdAt: z.string().trim().min(1).max(100),
  updatedAt: z.string().trim().min(1).max(100),
  source: z.enum(['remote-migration', 'local']),
  legacyKey: z.string().trim().min(1).max(500).nullable(),
}).strict();
export type CompletionMarkV2 = z.infer<typeof CompletionMarkV2Schema>;

/** The per-account payload intentionally contains no account-independent slot. */
export const CompletionFileV2Schema = z.object({
  version: z.literal(2),
  marks: z.record(CompletionMarkV2Schema),
}).strict().superRefine((value, ctx) => {
  for (const [key, mark] of Object.entries(value.marks)) {
    if (key !== mark.key) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['marks', key, 'key'], message: 'Completion mark key mismatch.' });
  }
});
export type CompletionFileV2 = z.infer<typeof CompletionFileV2Schema>;

const CompletionStoreEnvelopeV2Schema = z.object({
  schemaVersion: z.literal(2),
  scope: CompletionScopeV2Schema,
  file: CompletionFileV2Schema,
}).strict();
const CompletionMigrationRecordSchema = z.object({
  sourceScope: z.string().trim().min(1).max(500),
  targetUserId: Id,
  migrated: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  unmatched: z.number().int().nonnegative(),
  ambiguous: z.number().int().nonnegative(),
  backupCreated: z.boolean(),
  completedAt: z.string().trim().min(1).max(100),
}).strict();
const CompletionStoreFileV2Schema = z.object({
  version: z.literal(2),
  scopes: z.record(CompletionStoreEnvelopeV2Schema),
  migrations: z.record(CompletionMigrationRecordSchema),
}).strict().superRefine((value, ctx) => {
  for (const [key, envelope] of Object.entries(value.scopes)) {
    if (key !== storeKey(envelope.scope)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopes', key, 'scope'], message: 'Completion scope key mismatch.' });
  }
});
type CompletionStoreFileV2 = z.infer<typeof CompletionStoreFileV2Schema>;

export interface CompletionTaskIdentity {
  readonly courseId: string;
  readonly contentId?: string | null;
  readonly columnId?: string | null;
  readonly id?: string | null;
  readonly url?: string | null;
  readonly title?: string | null;
  readonly due?: string | null;
  readonly dueAt?: string | null;
  readonly dueDateOnly?: string | null;
}

export interface LegacyCompletionScope {
  readonly scopeKey: string;
  readonly marks: Readonly<Record<string, boolean>>;
  /** v1 local-account scopes do not prove this; callers must opt in explicitly. */
  readonly boundUserId?: string | null;
  /** Optional old Snapshot metadata used only for a stable URL crosswalk. */
  readonly taskMetadata?: Readonly<Record<string, CompletionTaskIdentity>>;
}

export type CompletionMatchConfidence = 'exact-id' | 'exact-column' | 'stable-url' | 'explicit-crosswalk';

export interface CompletionMigrationCandidate {
  readonly legacyKey: string;
  readonly newKey: string;
  readonly courseId: string;
  readonly title: string | null;
  readonly confidence: CompletionMatchConfidence;
}

export interface CompletionMigrationPlan {
  readonly migrationId: string;
  readonly sourceScope: string;
  readonly targetUserId: string;
  readonly accountBound: boolean;
  readonly requiresAccountConfirmation: boolean;
  readonly candidates: readonly CompletionMigrationCandidate[];
  readonly pendingLegacyKeys: readonly string[];
  readonly unmatchedLegacyKeys: readonly string[];
  readonly ambiguousLegacyKeys: readonly string[];
  /** The UI may offer these only after showing the account confirmation. */
  readonly allowedNewKeys: readonly string[];
  readonly preservedMarkCount: number;
}

export interface CompletionMigrationSelection {
  readonly legacyKey: string;
  readonly newKey: string;
}

const legacyHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Exact key formula used by the v1 Dashboard completion store. */
export function legacyCompletionKey(task: CompletionTaskIdentity): string {
  const courseId = task.courseId?.trim() || '';
  const value = task.due ?? task.dueAt ?? task.dueDateOnly ?? null;
  if (task.id?.trim() && courseId) return legacyHash(['classic-assignment', courseId, task.id.trim()]);
  if (task.columnId?.trim() && courseId) return legacyHash([courseId, task.columnId.trim()]);
  return legacyHash([courseId || null, task.title ?? null, value]);
}

export function completionKeyV2(task: CompletionTaskIdentity): string {
  const courseId = typeof task.courseId === 'string' ? task.courseId.trim() : '';
  if (!courseId) throw new ClassicApiError('BAD_INPUT', '完成标记缺少 courseId。', { scope: 'completion-v2.key', retryable: false });
  const stable = task.contentId?.trim() || task.id?.trim() || task.columnId?.trim();
  if (!stable) throw new ClassicApiError('BAD_INPUT', '完成标记缺少可验证的 contentId/columnId。', { scope: 'completion-v2.key', retryable: false });
  return legacyHash(['classic-assignment-v2', courseId, stable]);
}

function stableUrlKey(task: CompletionTaskIdentity): string | null {
  if (!task.url?.trim()) return null;
  try {
    const url = new URL(task.url);
    if (url.origin !== CLASSIC_API_ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || /(?:^|;)(?:jsession|session)id=/i.test(url.pathname)) return null;
    const declaredCourse = queryValue(url, ['course_id', 'courseId']);
    if (declaredCourse && declaredCourse !== task.courseId?.trim()) return null;
    const kept = [...url.searchParams.entries()]
      .filter(([key]) => !/(?:session|jsession|ticket|token|sso|auth|code|sig(?:nature)?|nonce|csrf|redirect|return)/i.test(key))
      .sort(([left], [right]) => left.localeCompare(right));
    url.search = new URLSearchParams(kept).toString();
    const courseId = task.courseId?.trim();
    return courseId ? legacyHash(['classic-url', courseId, url.href]) : null;
  } catch { return null; }
}

interface SourceIdentifiers {
  readonly courseId: string;
  readonly contentId: string | null;
  readonly columnId: string | null;
}

function queryValue(url: URL, names: readonly string[]): string | null {
  for (const name of names) {
    const value = url.searchParams.get(name)?.trim();
    if (value && value.length <= 300) return value;
  }
  return null;
}

/**
 * Recover only explicitly named Blackboard identifiers from an already
 * verified same-origin source URL. Generic `id` values and titles are never
 * treated as a crosswalk because they can identify a grade, folder, or other
 * unrelated resource.
 */
function sourceIdentifiers(task: CompletionTaskIdentity): SourceIdentifiers | null {
  const courseId = task.courseId?.trim();
  if (!courseId) return null;
  const directContentId = task.contentId?.trim() || null;
  const directColumnId = task.columnId?.trim() || null;
  if (!task.url?.trim()) return { courseId, contentId: directContentId, columnId: directColumnId };
  try {
    const url = new URL(task.url);
    if (url.origin !== CLASSIC_API_ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || /(?:^|;)(?:jsession|session)id=/i.test(url.pathname)) return null;
    const declaredCourse = queryValue(url, ['course_id', 'courseId']);
    if (declaredCourse && declaredCourse !== courseId) return null;
    const urlContentId = queryValue(url, ['content_id', 'contentId']);
    const urlColumnId = queryValue(url, ['column_id', 'columnId']);
    if ((directContentId && urlContentId && directContentId !== urlContentId) ||
        (directColumnId && urlColumnId && directColumnId !== urlColumnId)) return null;
    return {
      courseId,
      // Explicit metadata from the old snapshot is stronger than an absent
      // query parameter. If both sources exist, the equality check above
      // prevents a silent crosswalk to a different resource.
      contentId: directContentId ?? urlContentId,
      columnId: directColumnId ?? urlColumnId,
    };
  } catch { return null; }
}

function taskWithSourceIdentifiers(task: CompletionTaskIdentity): CompletionTaskIdentity {
  const source = sourceIdentifiers(task);
  if (!source) return task;
  return {
    ...task,
    contentId: task.contentId?.trim() || source.contentId,
    columnId: task.columnId?.trim() || source.columnId,
  };
}

interface CurrentTaskEntry {
  readonly task: CompletionTaskIdentity;
  readonly newKey: string;
  readonly legacyKey: string;
  readonly stableKey: string | null;
}

function taskEntries(tasks: readonly CompletionTaskIdentity[]): CurrentTaskEntry[] {
  const output: CurrentTaskEntry[] = [];
  for (const task of tasks) {
    const courseId = task.courseId?.trim();
    if (!courseId) continue;
    try {
      const sourceTask = { ...task, courseId };
      const source = sourceIdentifiers(sourceTask);
      // A conflicting explicit ID/URL or course query is unsafe for an
      // inferred crosswalk. Keep the task visible to the current snapshot,
      // but do not make it an automatic migration target.
      if (sourceTask.url?.trim() && !source) continue;
      const normalizedTask = taskWithSourceIdentifiers(sourceTask);
      output.push({ task: normalizedTask, newKey: completionKeyV2(normalizedTask), legacyKey: legacyCompletionKey(normalizedTask), stableKey: stableUrlKey(normalizedTask) });
    } catch {
      // A task without a stable current ID remains outside the migration map;
      // it must be shown as unmatched rather than title-matched.
    }
  }
  return output;
}

/**
 * Build a reviewable plan. Unbound legacy marks are still surfaced as
 * candidates, but no mark is applied until the user confirms the target
 * account. Ambiguous matches remain pending and are never first-item wins.
 */
export function planCompletionMigration(input: {
  readonly legacy: LegacyCompletionScope;
  readonly current: CompletionScopeV2;
  readonly tasks: readonly CompletionTaskIdentity[];
  readonly explicitCrosswalk?: Readonly<Record<string, string>>;
}): CompletionMigrationPlan {
  const current = CompletionScopeV2Schema.parse(input.current);
  const accountBound = Boolean(input.legacy.boundUserId && input.legacy.boundUserId === current.userId);
  const entries = taskEntries(input.tasks);
  const byNewKey = new Map<string, CurrentTaskEntry[]>();
  const byLegacyKey = new Map<string, CurrentTaskEntry[]>();
  const byStableKey = new Map<string, CurrentTaskEntry[]>();
  const byContentId = new Map<string, CurrentTaskEntry[]>();
  const byColumnId = new Map<string, CurrentTaskEntry[]>();
  for (const entry of entries) {
    const add = (map: Map<string, CurrentTaskEntry[]>, key: string | null) => {
      if (!key) return;
      const values = map.get(key) ?? [];
      values.push(entry);
      map.set(key, values);
    };
    add(byNewKey, entry.newKey);
    add(byLegacyKey, entry.legacyKey);
    add(byStableKey, entry.stableKey);
    const courseId = entry.task.courseId.trim();
    const contentId = entry.task.contentId?.trim();
    const columnId = entry.task.columnId?.trim();
    if (contentId) add(byContentId, `${courseId}\u0000${contentId}`);
    if (columnId) add(byColumnId, `${courseId}\u0000${columnId}`);
  }
  const candidates: CompletionMigrationCandidate[] = [];
  const pendingLegacyKeys: string[] = [];
  const unmatchedLegacyKeys: string[] = [];
  const ambiguousLegacyKeys: string[] = [];
  for (const [legacyKey, completed] of Object.entries(input.legacy.marks)) {
    if (typeof completed !== 'boolean') continue;
    const explicit = input.explicitCrosswalk?.[legacyKey];
    let matches = explicit ? (byNewKey.get(explicit) ?? []) : (byLegacyKey.get(legacyKey) ?? []);
    let confidence: CompletionMatchConfidence = explicit ? 'explicit-crosswalk' : 'exact-id';
    if (!explicit && matches.length === 0) {
      const metadata = input.legacy.taskMetadata?.[legacyKey];
      const source = metadata ? sourceIdentifiers(metadata) : null;
      if (source?.contentId) {
        matches = byContentId.get(`${source.courseId}\u0000${source.contentId}`) ?? [];
        confidence = 'exact-id';
      }
      if (matches.length === 0 && source?.columnId) {
        matches = byColumnId.get(`${source.courseId}\u0000${source.columnId}`) ?? [];
        confidence = 'exact-column';
      }
      // If the old metadata had an unsafe/conflicting source, do not let the
      // same URL quietly re-enter through the weaker stable-url fallback.
      if (matches.length === 0 && (!metadata || source !== null)) {
        const stable = metadata ? stableUrlKey(metadata) : null;
        matches = stable ? (byStableKey.get(stable) ?? []) : [];
        confidence = 'stable-url';
      }
    } else if (!explicit && matches.length > 0) {
      confidence = matches.some(entry => entry.task.id?.trim()) ? 'exact-id' : 'exact-column';
    }
    if (matches.length > 1) {
      ambiguousLegacyKeys.push(legacyKey);
      if (!accountBound) pendingLegacyKeys.push(legacyKey);
      continue;
    }
    if (matches.length === 0) {
      unmatchedLegacyKeys.push(legacyKey);
      if (!accountBound) pendingLegacyKeys.push(legacyKey);
      continue;
    }
    const entry = matches[0];
    if (!entry) {
      unmatchedLegacyKeys.push(legacyKey);
      if (!accountBound) pendingLegacyKeys.push(legacyKey);
      continue;
    }
    candidates.push({ legacyKey, newKey: entry.newKey, courseId: entry.task.courseId, title: entry.task.title ?? null, confidence });
    if (!accountBound) pendingLegacyKeys.push(legacyKey);
  }
  // Never let two old marks silently collapse onto one current task. Remove
  // those inferred candidates and leave both legacy keys for explicit review.
  const candidatesByNewKey = new Map<string, CompletionMigrationCandidate[]>();
  for (const candidate of candidates) {
    const values = candidatesByNewKey.get(candidate.newKey) ?? [];
    values.push(candidate);
    candidatesByNewKey.set(candidate.newKey, values);
  }
  const conflictingLegacyKeys = new Set<string>();
  for (const values of candidatesByNewKey.values()) {
    if (values.length <= 1) continue;
    for (const value of values) conflictingLegacyKeys.add(value.legacyKey);
  }
  if (conflictingLegacyKeys.size) {
    for (const legacyKey of conflictingLegacyKeys) {
      const index = candidates.findIndex(candidate => candidate.legacyKey === legacyKey);
      if (index >= 0) candidates.splice(index, 1);
      if (!ambiguousLegacyKeys.includes(legacyKey)) ambiguousLegacyKeys.push(legacyKey);
      if (!accountBound && !pendingLegacyKeys.includes(legacyKey)) pendingLegacyKeys.push(legacyKey);
    }
  }
  return {
    migrationId: randomUUID(),
    sourceScope: input.legacy.scopeKey,
    targetUserId: current.userId,
    accountBound,
    requiresAccountConfirmation: !accountBound,
    candidates,
    pendingLegacyKeys,
    unmatchedLegacyKeys,
    ambiguousLegacyKeys,
    allowedNewKeys: [...new Set(entries.map(entry => entry.newKey))],
    preservedMarkCount: Object.keys(input.legacy.marks).length,
  };
}

/** Apply only reviewed entries; existing v2 marks always win. */
export function applyCompletionMigration(input: {
  readonly file: CompletionFileV2;
  readonly plan: CompletionMigrationPlan;
  readonly legacy: LegacyCompletionScope;
  readonly selections?: readonly CompletionMigrationSelection[];
  readonly confirmAccount?: boolean;
  readonly confirmedUserId?: string;
  readonly now?: string;
}): CompletionFileV2 {
  const file = CompletionFileV2Schema.parse(input.file);
  if (input.plan.sourceScope !== input.legacy.scopeKey) throw new ClassicApiError('BAD_INPUT', '完成标记迁移预览与旧 scope 不一致。', { scope: 'completion-v2.apply', retryable: false });
  if (input.plan.requiresAccountConfirmation && (input.confirmAccount !== true || input.confirmedUserId !== input.plan.targetUserId)) {
    throw new ClassicApiError('BAD_INPUT', '迁移前必须明确确认当前 Blackboard 账号归属。', { scope: 'completion-v2.apply', retryable: false });
  }
  if (input.selections === undefined) {
    throw new ClassicApiError('BAD_INPUT', '迁移必须明确提交本次要应用的候选选择。', { scope: 'completion-v2.apply', retryable: false });
  }
  const allowedNewKeys = new Set(input.plan.allowedNewKeys);
  const legacyKeys = new Set(Object.keys(input.legacy.marks));
  for (const candidate of input.plan.candidates) {
    if (!legacyKeys.has(candidate.legacyKey) || !allowedNewKeys.has(candidate.newKey)) {
      throw new ClassicApiError('BAD_INPUT', '完成标记迁移计划已超出当前任务白名单。', { scope: 'completion-v2.apply', retryable: false });
    }
  }
  const planByLegacy = new Map(input.plan.candidates.map(item => [item.legacyKey, item]));
  // A selection may only choose a pair already shown in the preview. Merely
  // naming any current task would turn an unmatched legacy mark into a
  // silent arbitrary migration.
  const byLegacy = new Map<string, string>();
  const selectedNewKeys = new Set<string>();
  for (const selection of input.selections ?? []) {
    if (!legacyKeys.has(selection.legacyKey) || !allowedNewKeys.has(selection.newKey)) {
      throw new ClassicApiError('BAD_INPUT', '完成标记迁移选择不在当前预览白名单内。', { scope: 'completion-v2.apply', retryable: false });
    }
    const candidate = planByLegacy.get(selection.legacyKey);
    if (!candidate || candidate.newKey !== selection.newKey) {
      throw new ClassicApiError('BAD_INPUT', '完成标记迁移选择与当前预览候选不一致。', { scope: 'completion-v2.apply', retryable: false });
    }
    if (selectedNewKeys.has(selection.newKey)) throw new ClassicApiError('BAD_INPUT', '多个旧完成标记不能自动映射到同一新作业。', { scope: 'completion-v2.apply', retryable: false });
    selectedNewKeys.add(selection.newKey);
    byLegacy.set(selection.legacyKey, selection.newKey);
  }
  const mappedNewKeys = new Map<string, string>();
  for (const [legacyKey, newKey] of byLegacy) {
    const previousLegacy = mappedNewKeys.get(newKey);
    if (previousLegacy && previousLegacy !== legacyKey) throw new ClassicApiError('BAD_INPUT', '多个旧完成标记不能映射到同一新作业。', { scope: 'completion-v2.apply', retryable: false });
    mappedNewKeys.set(newKey, legacyKey);
  }
  const now = input.now ?? new Date().toISOString();
  const marks = { ...file.marks };
  for (const [legacyKey, completed] of Object.entries(input.legacy.marks)) {
    if (typeof completed !== 'boolean') continue;
    const newKey = byLegacy.get(legacyKey);
    if (!newKey || marks[newKey] !== undefined) continue;
    marks[newKey] = CompletionMarkV2Schema.parse({ key: newKey, completed, createdAt: now, updatedAt: now, source: 'remote-migration', legacyKey });
  }
  return CompletionFileV2Schema.parse({ version: 2, marks });
}

function storeKey(scope: CompletionScopeV2): string {
  return legacyHash([scope.profileId, scope.origin, scope.userId, scope.source, 2]);
}

function emptyStore(): CompletionStoreFileV2 { return { version: 2, scopes: {}, migrations: {} }; }

/**
 * Independent v2 local marker store. The encrypted cache is for remote
 * snapshots; this file contains only local booleans and is account-hash scoped
 * so the legacy local-account slot can never be read as another user.
 */
export class CompletionStoreV2 {
  private readonly file: string;

  constructor(file = join(stateHome(), 'dashboard-completion-v2.json')) { this.file = file; }

  private async read(): Promise<CompletionStoreFileV2> {
    let raw: string;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
      throw new ClassicApiError('CACHE_FALLBACK', 'v2 完成标记文件无法读取，原文件未覆盖。', { scope: 'completion-v2.read', stale: true, retryable: true });
    }
    try { return CompletionStoreFileV2Schema.parse(JSON.parse(raw)); }
    catch (error) { throw new ClassicApiError('CACHE_FALLBACK', 'v2 完成标记文件校验失败，原文件未覆盖。', { scope: 'completion-v2.read', stale: true, retryable: true, cause: error }); }
  }

  async load(scopeInput: CompletionScopeV2): Promise<CompletionFileV2> {
    const scope = CompletionScopeV2Schema.parse(scopeInput);
    const store = await this.read();
    return store.scopes[storeKey(scope)]?.file ?? { version: 2, marks: {} };
  }

  async set(scopeInput: CompletionScopeV2, key: string, completed: boolean | null): Promise<void> {
    const scope = CompletionScopeV2Schema.parse(scopeInput);
    if (!Key.safeParse(key).success) throw new ClassicApiError('BAD_INPUT', '完成标记 key 无效。', { scope: 'completion-v2.set', retryable: false });
    await locked(async () => {
      const store = await this.read();
      const keyForScope = storeKey(scope);
      const existing = store.scopes[keyForScope]?.file ?? { version: 2, marks: {} };
      const marks = { ...existing.marks };
      if (completed === null) delete marks[key];
      else {
        const now = new Date().toISOString();
        const previous = marks[key];
        marks[key] = CompletionMarkV2Schema.parse({ key, completed, createdAt: previous?.createdAt ?? now, updatedAt: now, source: 'local', legacyKey: previous?.legacyKey ?? null });
      }
      const file = CompletionFileV2Schema.parse({ version: 2, marks });
      store.scopes[keyForScope] = { schemaVersion: 2, scope, file };
      await atomicWrite(this.file, JSON.stringify(CompletionStoreFileV2Schema.parse(store)));
    });
  }

  async migrate(scopeInput: CompletionScopeV2, input: Omit<Parameters<typeof applyCompletionMigration>[0], 'file'>, options: { readonly legacySourcePath?: string } = {}): Promise<{ file: CompletionFileV2; migrated: number; pending: number; unmatched: number; ambiguous: number; backupCreated: boolean }> {
    const scope = CompletionScopeV2Schema.parse(scopeInput);
    if (input.plan.targetUserId !== scope.userId) throw new ClassicApiError('BAD_INPUT', '完成标记迁移目标账号与当前 scope 不一致。', { scope: 'completion-v2.apply', retryable: false });
    return locked(async () => {
      const store = await this.read();
      const previousMigration = store.migrations[input.plan.migrationId];
      if (previousMigration) {
        const file = store.scopes[storeKey(scope)]?.file ?? { version: 2, marks: {} };
        return { file, migrated: previousMigration.migrated, pending: previousMigration.pending, unmatched: previousMigration.unmatched, ambiguous: previousMigration.ambiguous, backupCreated: previousMigration.backupCreated };
      }
      const keyForScope = storeKey(scope);
      const existing = store.scopes[keyForScope]?.file ?? { version: 2, marks: {} };
      const file = applyCompletionMigration({ ...input, file: existing });
      let backupCreated = false;
      if (options.legacySourcePath) {
        const expectedLegacyPath = resolve(join(stateHome(), 'dashboard-completion.json'));
        if (!isAbsolute(options.legacySourcePath) || resolve(options.legacySourcePath) !== expectedLegacyPath) {
          throw new ClassicApiError('BAD_INPUT', '完成标记迁移只允许备份既有本地 v1 文件。', { scope: 'completion-v2.backup', retryable: false });
        }
        const backupPath = `${options.legacySourcePath}.v1-backup-${input.plan.migrationId}.json`;
        try { await copyFile(options.legacySourcePath, backupPath); backupCreated = true; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ClassicApiError('CACHE_FALLBACK', '旧完成标记备份失败，未写入 v2 标记。', { scope: 'completion-v2.backup', stale: true, retryable: false, cause: error });
        }
      }
      store.scopes[keyForScope] = { schemaVersion: 2, scope, file };
      const result = { migrated: Object.keys(file.marks).length - Object.keys(existing.marks).length, pending: input.plan.pendingLegacyKeys.length, unmatched: input.plan.unmatchedLegacyKeys.length, ambiguous: input.plan.ambiguousLegacyKeys.length, backupCreated };
      store.migrations[input.plan.migrationId] = { sourceScope: input.plan.sourceScope, targetUserId: input.plan.targetUserId, ...result, completedAt: new Date().toISOString() };
      await atomicWrite(this.file, JSON.stringify(CompletionStoreFileV2Schema.parse(store)));
      return { file, ...result };
    });
  }
}
