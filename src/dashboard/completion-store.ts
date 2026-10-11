import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, locked, stateHome } from '../config.js';
import type { DashboardTask } from './data.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const completionScope = (profile: string, origin: string, userId: string) => hash([profile, origin, userId]);
type CompletionTask = { id?: string; title: string; courseId?: string; course?: string; columnId?: string; due?: string; dueAt?: string | null; dueDateOnly?: string | null };
export const completionKey = (task: CompletionTask) => {
  const value = task.due ?? task.dueAt ?? task.dueDateOnly ?? null;
  if (task.id && task.courseId) return hash(['classic-assignment', task.courseId, task.id]);
  // Keep the existing CUHK Blackboard column key stable for legacy tasks.
  return task.columnId && task.courseId ? hash([task.courseId, task.columnId]) : hash([task.courseId || task.course, task.title, value]);
};
type Marks = Record<string, Record<string, boolean>>;

export class CompletionStore {
  constructor(private file = join(stateHome(), 'dashboard-completion.json')) {}
  private async read(): Promise<Marks> {
    let raw: string;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(scope =>
      !scope || typeof scope !== 'object' || Array.isArray(scope) || Object.values(scope).some(mark => typeof mark !== 'boolean'))) throw new Error('完成标记文件无法读取。');
    return value;
  }
  async load(scope: string) { return (await this.read())[scope] ?? {}; }
  async set(scope: string, key: string, value: boolean | null) {
    await locked(async () => {
      const marks = await this.read();
      const entries = marks[scope] ??= {};
      if (value === null) delete entries[key]; else entries[key] = value;
      await atomicWrite(this.file, JSON.stringify(marks));
    });
  }
}
