export type ClassicErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_CHECK_UNRECOGNIZED'
  | 'SESSION_EXPIRED'
  | 'CONNECTOR_START_FAILED'
  | 'CONNECTOR_DISCONNECTED'
  | 'COURSE_PARSE_CHANGED'
  | 'RESULT_PARSE_FAILED'
  | 'PARTIAL_RESULTS'
  | 'TIMEOUT'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'DOWNLOAD_FAILED'
  | 'URL_REJECTED'
  | 'TOOL_NOT_ALLOWED'
  | 'TOOL_UNAVAILABLE'
  | 'BAD_INPUT'
  | 'CACHE_READ_FAILED'
  | 'CACHE_WRITE_FAILED'
  | 'UPSTREAM_FAILED';

export class ClassicError extends Error {
  readonly code: ClassicErrorCode;
  readonly recoverable: boolean;
  readonly cause?: unknown;

  constructor(code: ClassicErrorCode, message: string, options: { recoverable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = 'ClassicError';
    this.code = code;
    this.recoverable = options.recoverable ?? !['BAD_INPUT', 'URL_REJECTED', 'TOOL_NOT_ALLOWED'].includes(code);
    this.cause = options.cause;
  }
}

const KNOWN_CODES = new Set<ClassicErrorCode>([
  'AUTH_REQUIRED', 'AUTH_CHECK_UNRECOGNIZED', 'SESSION_EXPIRED', 'CONNECTOR_START_FAILED', 'CONNECTOR_DISCONNECTED',
  'COURSE_PARSE_CHANGED', 'RESULT_PARSE_FAILED', 'PARTIAL_RESULTS', 'TIMEOUT', 'FORBIDDEN',
  'NOT_FOUND', 'DOWNLOAD_FAILED', 'URL_REJECTED', 'TOOL_NOT_ALLOWED', 'TOOL_UNAVAILABLE',
  'BAD_INPUT', 'CACHE_READ_FAILED', 'CACHE_WRITE_FAILED', 'UPSTREAM_FAILED',
]);

export interface PublicClassicError {
  code: ClassicErrorCode;
  message: string;
  recoverable: boolean;
}

export function publicClassicError(error: unknown): PublicClassicError {
  if (error instanceof ClassicError) return { code: error.code, message: error.message, recoverable: error.recoverable };
  return { code: 'UPSTREAM_FAILED', message: '读取 Blackboard 时发生错误，请稍后重试。', recoverable: true };
}

export function errorCode(value: unknown): ClassicErrorCode {
  if (typeof value === 'string' && KNOWN_CODES.has(value as ClassicErrorCode)) return value as ClassicErrorCode;
  return 'UPSTREAM_FAILED';
}

export function classifyConnectorError(error: unknown): ClassicError {
  if (error instanceof ClassicError) return error;
  const text = error instanceof Error ? error.message : String(error ?? '');
  if (/timeout|timed out/i.test(text)) return new ClassicError('TIMEOUT', 'Blackboard 读取超时，请重试。', { cause: error });
  if (/closed|disconnect|exit|broken pipe/i.test(text)) return new ClassicError('CONNECTOR_DISCONNECTED', 'Blackboard 连接已断开，请刷新重试。', { cause: error });
  if (/401|not.?auth|session.?expired|login/i.test(text)) return new ClassicError('AUTH_REQUIRED', '需要在本机完成 Blackboard 登录。', { cause: error });
  if (/403|forbidden|denied/i.test(text)) return new ClassicError('FORBIDDEN', 'Blackboard 拒绝访问该内容。', { cause: error });
  return new ClassicError('UPSTREAM_FAILED', 'Blackboard 连接失败，请稍后重试。', { cause: error });
}
