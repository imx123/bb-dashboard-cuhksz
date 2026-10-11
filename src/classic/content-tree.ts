import { ClassicApiError, publicApiError, type PublicClassicApiError } from './api-errors.js';
import type { ClassicApiClient, ClassicApiCallOptions } from './api-client.js';
import { createRequestBudget } from './pagination.js';
import { rawRecord, rawString, type RawContentNode } from './raw-schema.js';

export type ContentKind = 'folder' | 'file' | 'document' | 'assignment' | 'test-link' | 'external-link' | 'video' | 'unknown';

export interface ContentTreeNode {
  readonly courseId: string;
  readonly contentId: string;
  readonly parentId: string | null;
  readonly path: readonly string[];
  readonly title: string;
  readonly kind: ContentKind;
  readonly hasChildren: boolean;
  readonly available: boolean | null;
  readonly partiallyVisible: boolean | null;
  readonly restricted: boolean;
  readonly url: string | null;
  readonly handler: string | null;
  /** Preserve one API body so normalize/detail code does not issue a second GET. */
  readonly raw: RawContentNode;
}

export interface ContentTreeResult {
  readonly nodes: readonly ContentTreeNode[];
  readonly pages: number;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly restrictedNodes: number;
  readonly errors: readonly PublicClassicApiError[];
}

export interface ContentTreeOptions extends ClassicApiCallOptions {
  readonly maxNodes?: number;
  readonly maxDepth?: number;
  readonly maxPages?: number;
}

function handlerName(value: unknown): string | null {
  const direct = rawString(value);
  if (direct) return direct.toLowerCase();
  const item = rawRecord(value);
  return rawString(item?.id ?? item?.name ?? item?.type)?.toLowerCase() ?? null;
}

/** Only investigated handler values may become a domain kind. */
function contentKind(handler: string | null): ContentKind {
  const value = (handler ?? '').trim().toLowerCase();
  const known: Readonly<Record<string, ContentKind>> = {
    'resource/x-bb-folder': 'folder',
    'resource/x-bb-lesson': 'folder',
    'resource/x-bb-file': 'file',
    'resource/x-bb-document': 'document',
    'resource/x-bb-assignment': 'assignment',
    'resource/x-bb-asmt-test-link': 'test-link',
    'resource/x-bb-externallink': 'external-link',
    'resource/x-bb-video': 'video',
    folder: 'folder',
    lesson: 'folder',
    file: 'file',
    document: 'document',
    assignment: 'assignment',
    test: 'test-link',
    'test-link': 'test-link',
    externallink: 'external-link',
    'external-link': 'external-link',
    weblink: 'external-link',
    video: 'video',
  };
  return known[value] ?? 'unknown';
}

function booleanField(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function availability(item: Record<string, unknown>): { available: boolean | null; partiallyVisible: boolean | null; restricted: boolean } {
  const nested = rawRecord(item.availability);
  const available = booleanField(item.available ?? item.isAvailable ?? nested?.available ?? nested?.isAvailable);
  const partiallyVisible = booleanField(item.isPartiallyVisible ?? item.partiallyVisible ?? nested?.isPartiallyVisible ?? nested?.partiallyVisible);
  return { available, partiallyVisible, restricted: available === false && partiallyVisible === false };
}

function safeNodeUrl(value: unknown): string | null {
  const text = rawString(value);
  if (!text) return null;
  try {
    const url = new URL(text, 'https://bb.cuhk.edu.cn');
    // External-link/video nodes may intentionally point outside Blackboard;
    // keep a clean HTTPS source for an explicit user choice. The main-process
    // resource registry still accepts only the school origin for cookies.
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    for (const [key] of url.searchParams) if (/(?:token|ticket|code|saml|relay|state|session|jsession|cookie|auth|password|secret|signature|assertion|credential|nonce|key|otp|mfa)/i.test(key)) return null;
    return url.href;
  } catch { return null; }
}

function nodeFrom(courseId: string, parentId: string | null, path: readonly string[], item: RawContentNode): ContentTreeNode {
  const value = item as Record<string, unknown>;
  const contentId = rawString(value.id ?? value.contentId);
  if (!contentId) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 内容节点缺少 content ID。', { scope: `contents:${courseId}` });
  const title = rawString(value.title ?? value.name) ?? '';
  const handler = handlerName(value.contentHandler ?? value.handler ?? value.type);
  const state = availability(value);
  const kind = contentKind(handler);
  const handlerDetail = rawRecord(value.contentHandler);
  const declaredContainer = handlerDetail?.isFolder === true || handlerDetail?.isLesson === true;
  // A bare hasChildren flag is not enough to probe an unknown handler.  Keep
  // that visible node for the final DTO, but recurse only when Blackboard
  // identifies a folder/lesson container or explicitly marks the handler as
  // one of those containers.
  const hasChildren = value.hasChildren !== false && (declaredContainer || kind === 'folder');
  return {
    courseId,
    contentId,
    parentId,
    path: [...path, title],
    title,
    kind,
    hasChildren,
    available: state.available,
    partiallyVisible: state.partiallyVisible,
    restricted: state.restricted,
    url: safeNodeUrl(value.url ?? value.webLocation ?? value.permanentUrl),
    handler,
    raw: item,
  };
}

function isAuth(error: unknown): boolean {
  return error instanceof ClassicApiError && (error.code === 'AUTH_REQUIRED' || error.code === 'SESSION_EXPIRED');
}

function appendPageErrors(errors: PublicClassicApiError[], pageErrors: readonly PublicClassicApiError[]): void {
  for (const error of pageErrors) errors.push(error);
}

function isKnownRestriction(error: PublicClassicApiError): boolean {
  return error.code === 'FORBIDDEN' || error.code === 'CONTENT_UNAVAILABLE';
}

export async function readContentTree(api: ClassicApiClient, courseId: string, options: ContentTreeOptions): Promise<ContentTreeResult> {
  const maxNodes = options.maxNodes ?? 500;
  const maxDepth = options.maxDepth ?? 12;
  // Each collection follows the documented 20-page cap; the tree-wide cap
  // keeps recursive folder traversal bounded as well.
  const maxPages = options.maxPages ?? 100;
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 5_000 || !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 30 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1_000) {
    throw new ClassicApiError('BAD_INPUT', 'Classic 内容树预算无效。', { scope: `contents:${courseId}`, retryable: false });
  }
  const budget = options.budget ?? createRequestBudget(options.signal, { deadlineMs: 90_000, requestLimit: 300 });
  const nodes: ContentTreeNode[] = [];
  const visited = new Set<string>();
  const errors: PublicClassicApiError[] = [];
  let pages = 0;
  let complete = true;
  let truncated = false;
  let restrictedNodes = 0;

  const visit = async (parentId: string | undefined, path: readonly string[], depth: number): Promise<void> => {
    if (depth > maxDepth || nodes.length >= maxNodes) { truncated = true; complete = false; return; }
    if (pages >= maxPages) { truncated = true; complete = false; return; }
    let page;
    try {
      page = await api.contents({ signal: options.signal, traceId: options.traceId, budget }, courseId, parentId, { limit: 100 }, Math.min(20, Math.max(1, maxPages - pages)));
    } catch (error) {
      if (isAuth(error)) throw error;
      complete = false;
      const publicError = publicApiError(error);
      if (isKnownRestriction(publicError)) restrictedNodes += 1;
      errors.push(publicError);
      return;
    }
    pages += page.pages;
    appendPageErrors(errors, page.errors);
    if (page.errors.some(isKnownRestriction)) restrictedNodes += 1;
    if (!page.complete) { complete = false; truncated ||= page.truncated; }
    for (const item of page.items) {
      if (nodes.length >= maxNodes) { truncated = true; complete = false; break; }
      let current: ContentTreeNode;
      try { current = nodeFrom(courseId, parentId ?? null, path, item); }
      catch (error) {
        if (isAuth(error)) throw error;
        complete = false;
        errors.push(publicApiError(error));
        continue;
      }
      const key = `${courseId}\0${current.contentId}`;
      if (visited.has(key)) continue;
      visited.add(key);
      nodes.push(current);
      if (current.restricted) { restrictedNodes += 1; complete = false; continue; }
      if (!current.hasChildren) continue;
      await visit(current.contentId, current.path, depth + 1);
    }
  };

  try {
    await visit(undefined, [], 0);
  } catch (error) {
    if (isAuth(error)) throw error;
    complete = false;
    errors.push(publicApiError(error));
  }
  return { nodes, pages, complete: complete && errors.length === 0, truncated, restrictedNodes, errors };
}
