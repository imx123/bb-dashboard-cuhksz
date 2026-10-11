import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { stateHome } from './config.js';

/**
 * Local-only structured diagnostics for the dashboard and its MCP client.
 *
 * The logger is deliberately best-effort: a full disk, locked file, or
 * unavailable state directory must never make a read or login fail.  Values
 * are reduced before they enter the JSONL file; callers should still pass
 * counts, codes and other bounded metadata rather than page content.
 */

const TRACE_ID = /^[0-9a-f-]{16,64}$/i;
const MAX_BYTES = 1_000_000;
const MAX_ROTATED_FILES = 3;
const traceStorage = new AsyncLocalStorage<string>();

const SENSITIVE_KEY = /(?:password|passwd|cookie|token|ticket|assertion|saml|session(?:id)?|secret|credential|authorization|user.?data.?dir|header|body|html)/i;
const SENSITIVE_QUERY_KEY = /(?:token|ticket|code|saml|relay|state|session|jsession|cookie|auth|password|secret|signature|assertion|credential|nonce|key|otp|mfa)/i;
const STABLE_ID = /^(?:_[0-9]{1,24}_[0-9]{1,24}|[0-9]{1,32}|(?:assignment|announcement|file|course):_[0-9]{1,24}_1:[a-f0-9]{20})$/i;
const SAFE_ID_QUERY_KEYS = new Set(['course_id', 'courseid', 'content_id', 'contentid', 'assessment_id', 'assessmentid', 'assignment_id', 'assignmentid', 'item_id', 'itemid', 'cmp_tab_id', 'id']);
const SAFE_NAV_ENUMS: Record<string, ReadonlySet<string>> = {
  action: new Set(['default', 'display', 'list', 'load', 'login', 'logout', 'open', 'refresh', 'relogin', 'show', 'view']),
  mode: new Set(['content', 'course', 'default', 'display', 'list', 'portal', 'read', 'view']),
};

export type DebugFields = Record<string, unknown>;

function normalizeTraceId(value: unknown): string | undefined {
  return typeof value === 'string' && TRACE_ID.test(value) ? value : undefined;
}

export function createTraceId(): string {
  return randomUUID();
}

export function currentTraceId(): string | undefined {
  return traceStorage.getStore();
}

export function runWithTrace<T>(traceId: string | undefined, fn: () => T): T {
  return traceStorage.run(normalizeTraceId(traceId) ?? createTraceId(), fn);
}

export function debugLogDirectory(): string {
  return join(stateHome(), 'logs');
}

export function debugLogPath(): string {
  return join(debugLogDirectory(), 'dashboard-debug.jsonl');
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '[url-redacted]';
    const query = [...url.searchParams.entries()].map(([key, raw]) => {
      const cleanKey = key.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) || '[redacted-key]';
      const foldedKey = cleanKey.toLowerCase();
      let cleanValue = '[redacted]';
      if (SAFE_ID_QUERY_KEYS.has(foldedKey) && STABLE_ID.test(raw)) cleanValue = raw;
      else if (foldedKey === 'tab_tab_group_id' && /^_[0-9]{1,4}_[0-9]{1,4}$/.test(raw)) cleanValue = raw;
      else if (SAFE_NAV_ENUMS[foldedKey]?.has(raw.toLowerCase())) cleanValue = raw;
      else if (/^[0-9]{1,32}$/.test(raw) && ['page', 'offset', 'limit'].includes(foldedKey)) cleanValue = raw;
      else if (SENSITIVE_QUERY_KEY.test(foldedKey) || SENSITIVE_QUERY_KEY.test(raw)) cleanValue = '[redacted]';
      return `${encodeURIComponent(cleanKey)}=${encodeURIComponent(cleanValue)}`;
    });
    const pathname = (url.pathname || '/').replace(/;(?:(?:jsessionid|sessionid|token|ticket|assertion|saml))=[^/;]*/gi, ';[redacted]').split('/').map(segment => {
      if (!segment) return segment;
      if (segment.length > 120 || (url.hostname !== 'bb.cuhk.edu.cn' && /^[A-Za-z0-9+/_=-]{40,}$/.test(segment)) || /^(?:jsessionid|sessionid|token|ticket|assertion|saml)=/i.test(segment)) return '[redacted]';
      return segment;
    }).join('/').slice(0, 640) || '/';
    return `${url.origin}${pathname}${query.length ? `?${query.join('&')}` : ''}`;
  } catch {
    return '[url-redacted]';
  }
}

function safeString(value: string): string {
  const urls = value.replace(/https?:\/\/[^\s)\]}]+/gi, match => safeUrl(match.replace(/[.,;]+$/, '')));
  return urls
    .replace(/(?:cookie|authorization|token|ticket|assertion|saml|sessionid|password|验证码|密码)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .slice(0, 600);
}

function sanitize(value: unknown, key = '', depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/url|href|target|location|redirect/i.test(key)) return safeUrl(value);
    return safeString(value);
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitize(item, key, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      output[childKey] = sanitize(childValue, childKey, depth + 1);
    }
    return output;
  }
  return String(value).slice(0, 120);
}

function errorFields(error: unknown): DebugFields {
  if (!error || typeof error !== 'object') return {};
  const item = error as { code?: unknown; scope?: unknown; name?: unknown };
  return {
    ...(typeof item.code === 'string' ? { errorCode: item.code } : {}),
    ...(typeof item.scope === 'string' ? { errorScope: item.scope } : {}),
    ...(typeof item.name === 'string' ? { errorName: item.name } : {}),
  };
}

class DebugLogger {
  private pending: Promise<void> = Promise.resolve();
  private initialized = false;
  private initializing?: Promise<void>;
  private lastWriteOk = false;
  private writeCount = 0;
  private lastWriteAt?: number;
  private lastWriteError?: string;
  private externalWriteError?: string;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      try {
        await mkdir(debugLogDirectory(), { recursive: true, mode: 0o700 });
        this.initialized = true;
        this.lastWriteOk = true;
      } catch {
        this.lastWriteOk = false;
        this.lastWriteError = 'LOG_DIR_INIT_FAILED';
      } finally {
        this.initializing = undefined;
      }
    })();
    await this.initializing;
  }

  event(event: string, fields: DebugFields = {}): string {
    const traceId = currentTraceId() ?? createTraceId();
    try {
      const entry = {
        ts: Date.now(),
        traceId,
        component: 'dashboard',
        event: safeString(event),
        ...((sanitize(fields) as DebugFields) ?? {}),
      };
      const line = `${JSON.stringify(entry)}\n`;
      this.pending = this.pending.then(() => this.persist(line)).catch(() => {});
    } catch {
      // Diagnostics are advisory and must never change product behavior.
    }
    return traceId;
  }

  error(event: string, error: unknown, fields: DebugFields = {}): string {
    return this.event(event, { ...fields, ...errorFields(error) });
  }

  async flush(): Promise<void> {
    await this.pending.catch(() => {});
  }

  info(traceId?: string): { directory: string; path: string; traceId: string | null; writerReady: boolean; healthy: boolean; writeCount: number; lastWriteAt: number | null; lastWriteError: string | null } {
    return {
      directory: debugLogDirectory(),
      path: debugLogPath(),
      traceId: normalizeTraceId(traceId) ?? currentTraceId() ?? null,
      writerReady: this.initialized,
      healthy: this.initialized && this.lastWriteOk && !this.externalWriteError,
      writeCount: this.writeCount,
      lastWriteAt: this.lastWriteAt ?? null,
      lastWriteError: this.externalWriteError ?? this.lastWriteError ?? null,
    };
  }

  markExternalWriteFailure(code: 'BB_DEBUG_LOG_WRITE_FAILED'): void {
    this.externalWriteError = code;
  }

  private async persist(line: string): Promise<void> {
    const directory = debugLogDirectory();
    const file = debugLogPath();
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      this.initialized = true;
      let size = 0;
      try { size = (await stat(file)).size; } catch { /* first write */ }
      if (size + Buffer.byteLength(line, 'utf8') > MAX_BYTES) {
        for (let index = MAX_ROTATED_FILES - 1; index >= 1; index--) {
          await unlink(`${file}.${index + 1}`).catch(() => {});
          await rename(`${file}.${index}`, `${file}.${index + 1}`).catch(() => {});
        }
        await unlink(`${file}.1`).catch(() => {});
        await rename(file, `${file}.1`).catch(() => {});
      }
      await appendFile(file, line, { encoding: 'utf8', mode: 0o600 });
      this.lastWriteOk = true;
      this.writeCount += 1;
      this.lastWriteAt = Date.now();
    } catch {
      // Diagnostics are advisory and must never change product behavior.
      this.lastWriteOk = false;
      this.lastWriteError = 'LOG_WRITE_FAILED';
    }
  }
}

export const debugLog = new DebugLogger();

