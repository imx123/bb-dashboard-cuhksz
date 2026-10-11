import { CLASSIC_API_ORIGIN } from './api-contract.js';

const MAX_HTML_CHARS = 500_000;
const MAX_IMAGE_SOURCES = 500;
const IMAGE_SRC = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const CONTEXT_SEGMENT = /^pid-(.+)-dt-announcement-rid-([A-Za-z0-9][A-Za-z0-9_-]{0,120})$/i;
const RESOURCE_SEGMENT = /^(xid|rid)-([A-Za-z0-9][A-Za-z0-9_-]{0,120})$/i;
const STRUCTURED_URL_KEYS = new Set(['weblocation', 'filelocation', 'canonicalurl', 'canonical_url']);
const SENSITIVE_QUERY_KEY = /(?:token|ticket|code|saml|relay|state|session|jsession|cookie|auth|password|secret|signature|assertion|credential|nonce|key|otp|mfa)/i;

export interface BbcsWebDavImageSource {
  readonly key: string;
  readonly url: string;
  readonly prefixed: boolean;
}

export interface BbcsWebDavImageContext {
  readonly imageUrls: ReadonlyMap<string, string>;
  readonly referenceCount: number;
  readonly matchedCount: number;
  readonly ambiguousCount: number;
  readonly unresolvedCount: number;
}

interface ParsedPath {
  readonly key: string;
  readonly prefixSegment: string | null;
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function safeUrl(value: string, base?: URL): URL | null {
  try {
    const url = new URL(value, base ?? CLASSIC_API_ORIGIN);
    if (url.protocol !== 'https:' || url.origin !== CLASSIC_API_ORIGIN || url.username || url.password || url.port || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function parsePath(url: URL): ParsedPath | null {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2 || segments[0]?.toLowerCase() !== 'bbcswebdav') return null;
  const context = CONTEXT_SEGMENT.exec(segments[1] ?? '');
  if (context) {
    const key = context[2]?.toLowerCase();
    if (!key) return null;
    const resource = RESOURCE_SEGMENT.exec(segments[2] ?? '');
    if (resource && resource[1]?.toLowerCase() === 'xid' && resource[2]?.toLowerCase() !== key) return null;
    return { key, prefixSegment: segments[1]! };
  }
  const resource = RESOURCE_SEGMENT.exec(segments[1] ?? '');
  const key = resource?.[2]?.toLowerCase();
  if (!key) return null;
  return { key, prefixSegment: null };
}

function sourceFromValue(value: string, base?: URL): BbcsWebDavImageSource | null {
  const url = safeUrl(decodeAttribute(value.trim()), base);
  if (!url) return null;
  const parsed = parsePath(url);
  if (!parsed) return null;
  return { key: parsed.key, url: url.href, prefixed: parsed.prefixSegment !== null };
}

/** Inspect one already-normalized resource URL without exposing parser internals. */
export function inspectBbcsWebDavSource(value: string | URL, baseUrl?: string | URL): BbcsWebDavImageSource | null {
  const base = safeUrl(String(baseUrl ?? CLASSIC_API_ORIGIN));
  if (!base) return null;
  return sourceFromValue(value instanceof URL ? value.href : value, base);
}

/**
 * Accept only the two Blackboard page shapes that can establish the resource
 * context for this session. A same-origin URL alone is insufficient: the
 * course query must bind the page to the course being rendered.
 */
export function safeBbcsWebDavSourcePage(value: string | URL, courseId: string, contentId?: string): URL | null {
  const url = safeUrl(value instanceof URL ? value.href : value);
  if (!url || !courseId) return null;
  for (const [key] of url.searchParams) if (SENSITIVE_QUERY_KEY.test(key)) return null;
  const path = url.pathname.toLowerCase();
  const pageCourseId = url.searchParams.get('course_id');
  if (pageCourseId !== courseId) return null;
  if (path === '/webapps/blackboard/execute/announcement') return contentId ? null : url;
  if (path === '/webapps/blackboard/content/listcontent.jsp') {
    return contentId && url.searchParams.get('content_id') === contentId ? url : null;
  }
  return null;
}

export function fallbackBbcsWebDavSourcePage(courseId: string, contentId?: string): URL {
  const url = new URL(contentId ? '/webapps/blackboard/content/listContent.jsp' : '/webapps/blackboard/execute/announcement', CLASSIC_API_ORIGIN);
  url.searchParams.set('course_id', courseId);
  if (contentId) url.searchParams.set('content_id', contentId);
  else {
    url.searchParams.set('method', 'search');
    url.searchParams.set('context', 'course_entry');
  }
  return url;
}

/** Find a same-course page URL carried by a documented nested text field. */
export function findBbcsWebDavSourcePage(value: unknown, courseId: string, contentId?: string, depth = 0): URL | null {
  if (depth > 4 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findBbcsWebDavSourcePage(item, courseId, contentId, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string' && STRUCTURED_URL_KEYS.has(key.toLowerCase())) {
      const found = safeBbcsWebDavSourcePage(item, courseId, contentId);
      if (found) return found;
    } else if (item && typeof item === 'object') {
      const found = findBbcsWebDavSourcePage(item, courseId, contentId, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function extractBbcsWebDavImageSources(html: string, baseUrl?: string | URL): BbcsWebDavImageSource[] {
  const base = safeUrl(String(baseUrl ?? CLASSIC_API_ORIGIN));
  if (!base) return [];
  const input = html.slice(0, MAX_HTML_CHARS);
  const output: BbcsWebDavImageSource[] = [];
  IMAGE_SRC.lastIndex = 0;
  let match: RegExpExecArray | null;
  while (output.length < MAX_IMAGE_SOURCES && (match = IMAGE_SRC.exec(input))) {
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    const source = sourceFromValue(raw, base);
    if (source) output.push(source);
  }
  return output;
}

/** Preserve only the URL-bearing fields documented by Blackboard's rich-text envelope. */
export function extractStructuredBbcsWebDavSources(value: unknown, baseUrl?: string | URL): BbcsWebDavImageSource[] {
  const base = safeUrl(String(baseUrl ?? CLASSIC_API_ORIGIN));
  if (!base) return [];
  const output: BbcsWebDavImageSource[] = [];
  const visit = (current: unknown, depth: number): void => {
    if (output.length >= MAX_IMAGE_SOURCES || depth > 4 || current === null || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
      if (typeof item === 'string' && STRUCTURED_URL_KEYS.has(key.toLowerCase())) {
        const source = sourceFromValue(item, base);
        if (source) output.push(source);
      } else if (item && typeof item === 'object') {
        visit(item, depth + 1);
      }
    }
  };
  visit(value, 0);
  return output;
}

function richTextSource(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return '';
  const record = value as Record<string, unknown>;
  let fallback = '';
  for (const key of ['displayText', 'rawText', 'text', 'content', 'description', 'body']) {
    const candidate = record[key];
    if (typeof candidate === 'string') {
      if (!fallback) fallback = candidate;
      if (candidate.trim()) return candidate;
    } else if (candidate && typeof candidate === 'object') {
      const nested = richTextSource(candidate, depth + 1);
      if (!fallback) fallback = nested;
      if (nested.trim()) return nested;
    }
  }
  return fallback;
}

/** Match only exact bbcswebdav keys already present in the same rich-text envelope. */
export function prepareBbcsWebDavImageContext(value: unknown, baseUrl?: string | URL): BbcsWebDavImageContext {
  const bodySources = extractBbcsWebDavImageSources(richTextSource(value), baseUrl);
  const referenceKeys = new Set(bodySources.filter(source => !source.prefixed).map(source => source.key));
  const candidates = new Map<string, Set<string>>();
  const add = (source: BbcsWebDavImageSource): void => {
    if (!source.prefixed || !referenceKeys.has(source.key)) return;
    const values = candidates.get(source.key) ?? new Set<string>();
    values.add(source.url);
    candidates.set(source.key, values);
  };
  for (const source of bodySources) add(source);
  for (const source of extractStructuredBbcsWebDavSources(value, baseUrl)) add(source);
  const imageUrls = new Map<string, string>();
  let ambiguousCount = 0;
  let unresolvedCount = 0;
  for (const key of referenceKeys) {
    const values = candidates.get(key);
    if (values?.size === 1) imageUrls.set(key, [...values][0]!);
    else if (values && values.size > 1) ambiguousCount += 1;
    else unresolvedCount += 1;
  }
  return {
    imageUrls,
    referenceCount: referenceKeys.size,
    matchedCount: imageUrls.size,
    ambiguousCount,
    unresolvedCount,
  };
}

export function bbcsWebDavKey(value: string | URL): string | null {
  const url = value instanceof URL ? safeUrl(value.href) : safeUrl(value);
  return url ? parsePath(url)?.key ?? null : null;
}

export function resolveBbcsWebDavImage(value: string, imageUrls?: ReadonlyMap<string, string>): string {
  if (!imageUrls) return value;
  const url = safeUrl(value);
  if (!url) return value;
  const parsed = parsePath(url);
  if (!parsed || parsed.prefixSegment || !imageUrls.has(parsed.key)) return value;
  return imageUrls.get(parsed.key) ?? value;
}

/**
 * A confirmed prefixed first hop carries its announcement context through a
 * Blackboard Location that drops the prefix. A bare xid never gains a
 * guessed prefix here.
 */
export function restoreBbcsWebDavPrefix(initial: URL, next: URL): URL {
  const initialPath = parsePath(initial);
  if (!initialPath?.prefixSegment || next.origin !== CLASSIC_API_ORIGIN) return next;
  const segments = next.pathname.split('/').filter(Boolean);
  if (segments.length < 2 || segments[0]?.toLowerCase() !== 'bbcswebdav') return next;
  if (CONTEXT_SEGMENT.test(segments[1] ?? '')) return next;
  const nextPath = parsePath(next);
  if (nextPath && nextPath.key !== initialPath.key) return next;
  const remainder = next.pathname.slice('/bbcswebdav/'.length);
  if (!remainder || !(remainder.toLowerCase().startsWith('courses/') || /^xid-/i.test(remainder))) return next;
  const restored = new URL(next.href);
  restored.pathname = `/bbcswebdav/${initialPath.prefixSegment}/${remainder}`;
  return restored;
}
