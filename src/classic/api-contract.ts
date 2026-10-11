import type { ClassicApiErrorCode } from './api-errors.js';

export const CLASSIC_API_ORIGIN = 'https://bb.cuhk.edu.cn' as const;
export type ClassicApiOrigin = typeof CLASSIC_API_ORIGIN;

export type TraceId = string;
export type ClassicApiMethod = 'GET' | 'HEAD';
export type ClassicApiResource = 'identity' | 'memberships' | 'courses' | 'announcements' | 'contents' | 'grades' | 'attempts' | 'attachments' | 'calendar' | 'version';

export interface ClassicAccountContext {
  readonly profileId: string;
  readonly origin: ClassicApiOrigin;
  readonly userId: string;
  readonly sessionGeneration: number;
  readonly timezone: 'Asia/Shanghai';
}

export type ClassicSessionState = 'unauthenticated' | 'authenticating' | 'authenticated' | 'expired' | 'unknown';

export interface ClassicSessionSnapshot {
  readonly state: ClassicSessionState;
  readonly account: ClassicAccountContext | null;
  readonly generation: number;
  readonly errorCode?: ClassicApiErrorCode;
}

/** Internal cookie metadata. It must never cross the renderer/MCP boundary. */
export interface ClassicCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly expiresAt: number | null;
}

export interface ClassicSession {
  readonly state: ClassicSessionState;
  readonly account: ClassicAccountContext | null;
  readonly generation: number;
  beginLogin(signal?: AbortSignal, traceId?: TraceId): Promise<ClassicSessionSnapshot>;
  completeLogin(signal?: AbortSignal, traceId?: TraceId): Promise<ClassicSessionSnapshot>;
  ensureAuthenticated(signal: AbortSignal, traceId?: TraceId): Promise<ClassicSessionSnapshot>;
  cookiesFor(url: URL, signal?: AbortSignal): Promise<readonly ClassicCookie[]>;
  applySetCookie(url: URL, values: readonly string[], signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface ClassicRequestBudget {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly requestLimit: number;
  readonly responseBytesLimit: number;
  /** Requests held back for a final on-budget identity check. */
  readonly reserveRequests?: number;
  /** Milliseconds held back for a final on-budget identity check. */
  readonly reserveMs?: number;
}

export interface ClassicApiCallOptions {
  readonly signal: AbortSignal;
  readonly traceId?: TraceId;
  readonly budget?: ClassicRequestBudget;
  /** Internal main-process phase; never accepted from renderer arguments. */
  readonly allowReservedBudget?: boolean;
}

export interface ClassicApiRequest {
  readonly method: ClassicApiMethod;
  readonly url: URL;
  readonly resource: ClassicApiResource;
  readonly courseId?: string;
  readonly traceId?: TraceId;
  readonly budget: ClassicRequestBudget;
  readonly allowReservedBudget?: boolean;
}

export interface ClassicApiResponse<T = unknown> {
  readonly status: number;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly data: T | null;
  readonly bytes: number;
}

export interface ClassicApiTransport {
  request<T = unknown>(request: ClassicApiRequest): Promise<ClassicApiResponse<T>>;
}

export interface ClassicApiErrorInfo {
  readonly code: ClassicApiErrorCode;
  readonly scope: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly stale?: boolean;
}
