import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

const legacyHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function completionKeyV2(task: CompletionTaskIdentity): string {
  const courseId = typeof task.courseId === 'string' ? task.courseId.trim() : '';
  if (!courseId) throw new ClassicApiError('BAD_INPUT', '完成标记缺少 courseId。', { scope: 'completion-v2.key', retryable: false });
  const stable = task.contentId?.trim() || task.id?.trim() || task.columnId?.trim();
  if (!stable) throw new ClassicApiError('BAD_INPUT', '完成标记缺少可验证的 contentId/columnId。', { scope: 'completion-v2.key', retryable: false });
  return legacyHash(['classic-assignment-v2', courseId, stable]);
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


}
