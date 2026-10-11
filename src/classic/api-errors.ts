import { z } from 'zod';

export const ClassicApiErrorCodeSchema = z.enum([
  'AUTH_REQUIRED',
  'SESSION_EXPIRED',
  'FORBIDDEN',
  'CONTENT_UNAVAILABLE',
  'ENDPOINT_UNSUPPORTED',
  'NOT_FOUND',
  'RATE_LIMITED',
  'TIMEOUT',
  'NETWORK',
  'API_SCHEMA_CHANGED',
  'PARTIAL_RESULTS',
  'CACHE_FALLBACK',
  'URL_REJECTED',
  'RESOURCE_FAILED',
  'BAD_INPUT',
]);
export type ClassicApiErrorCode = z.infer<typeof ClassicApiErrorCodeSchema>;

const RETRYABLE = new Set<ClassicApiErrorCode>(['RATE_LIMITED', 'TIMEOUT', 'NETWORK', 'PARTIAL_RESULTS', 'RESOURCE_FAILED']);

export interface ClassicApiErrorOptions {
  readonly scope: string;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly stale?: boolean;
  readonly cause?: unknown;
}

export interface PublicClassicApiError {
  readonly code: ClassicApiErrorCode;
  readonly scope: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly stale?: boolean;
}

/**
 * API errors carry a fixed user-facing code and scope. `cause` stays private
 * to the main process and is intentionally omitted by `toPublic()`.
 */
export class ClassicApiError extends Error {
  readonly code: ClassicApiErrorCode;
  readonly scope: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly stale?: boolean;
  readonly cause?: unknown;

  constructor(code: ClassicApiErrorCode, message: string, options: ClassicApiErrorOptions) {
    super(message);
    this.name = 'ClassicApiError';
    this.code = code;
    this.scope = options.scope;
    this.status = options.status;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.stale = options.stale;
    this.cause = options.cause;
  }

  toPublic(): PublicClassicApiError {
    return {
      code: this.code,
      scope: this.scope,
      ...(this.status === undefined ? {} : { status: this.status }),
      retryable: this.retryable,
      ...(this.stale === undefined ? {} : { stale: this.stale }),
    };
  }
}

export function isClassicApiError(value: unknown): value is ClassicApiError {
  return value instanceof ClassicApiError;
}

export function isAuthenticationError(value: unknown): boolean {
  return value instanceof ClassicApiError && (value.code === 'AUTH_REQUIRED' || value.code === 'SESSION_EXPIRED');
}

export function apiErrorCode(value: unknown): ClassicApiErrorCode {
  if (typeof value === 'string' && ClassicApiErrorCodeSchema.safeParse(value).success) return value as ClassicApiErrorCode;
  return 'RESOURCE_FAILED';
}

export function apiErrorFromStatus(status: number, scope: string, url: URL): ClassicApiError {
  if (status === 401) return new ClassicApiError('SESSION_EXPIRED', 'Blackboard 会话已过期，请重新登录。', { scope, status });
  if (status === 403) return new ClassicApiError('FORBIDDEN', 'Blackboard 拒绝访问该内容。', { scope, status, retryable: false });
  if (status === 404) return new ClassicApiError('NOT_FOUND', 'Blackboard 未找到该资源。', { scope, status, retryable: false });
  if (status === 429) return new ClassicApiError('RATE_LIMITED', 'Blackboard 请求过于频繁，请稍后重试。', { scope, status });
  if (status >= 500) return new ClassicApiError('NETWORK', 'Blackboard 服务暂时不可用，请稍后重试。', { scope, status });
  return new ClassicApiError('RESOURCE_FAILED', `Blackboard 请求失败（HTTP ${status}）。`, { scope, status, retryable: false, cause: url.href });
}

export function publicApiError(value: unknown): PublicClassicApiError {
  if (value instanceof ClassicApiError) return value.toPublic();
  return { code: 'RESOURCE_FAILED', scope: 'unknown', retryable: true };
}
