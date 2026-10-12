import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../config.js';

/** Local setup metadata only; no cookies, account IDs or cached course data. */
export class DashboardStartupHistory {
  private verified = false;
  readonly file: string;

  constructor(home: string) { this.file = join(home, 'dashboard-startup.json'); }
  get canRestore(): boolean { return this.verified; }

  async initialize(): Promise<void> {
    this.verified = false;
    try {
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (value && typeof value === 'object' &&
          (value as Record<string, unknown>).version === 1 &&
          (value as Record<string, unknown>).hasVerifiedLogin === true) this.verified = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async recordVerifiedLogin(): Promise<void> {
    await atomicWrite(this.file, JSON.stringify({ version: 1, hasVerifiedLogin: true }));
    this.verified = true;
  }
}
