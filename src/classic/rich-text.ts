import { createRequire } from 'node:module';
import { CLASSIC_API_ORIGIN } from './api-contract.js';
import type { RichBody } from './schema-v2.js';

const MAX_INPUT_CHARS = 500_000;
const MAX_HTML_CHARS = 500_000;
const MAX_IMAGES = 500;
const MAX_LINKS = 500;
const SENSITIVE_LINK_QUERY = /(?:token|ticket|code|saml|relay|state|session|jsession|cookie|auth|password|secret|signature|assertion|credential|nonce|key|otp|mfa)/i;

const ALLOWED_TAGS = [
  'p', 'div', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins',
  'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody',
  'tfoot', 'tr', 'th', 'td', 'caption', 'pre', 'code', 'kbd', 'samp', 'sub',
  'sup', 'span', 'a', 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
] as const;

const BLOCK_TAGS = new Set<string>([
  'p', 'div', 'br', 'hr', 'blockquote', 'li', 'dt', 'dd', 'tr', 'th', 'td',
  'caption', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'dl', 'table',
]);

type Attributes = Record<string, string>;
type TransformResult = { tagName: string; attribs: Attributes; text?: string };
type SanitizeOptions = {
  allowedTags: readonly string[];
  allowedAttributes: Record<string, readonly string[]>;
  allowedSchemes: readonly string[];
  allowedSchemesAppliedToAttributes: readonly string[];
  allowProtocolRelative: boolean;
  transformTags: Record<string, (tagName: string, attribs: Attributes) => TransformResult>;
  onOpenTag: (name: string, attribs: Attributes) => void;
  onCloseTag: (name: string) => void;
  textFilter: (text: string, tagName: string) => string;
};
type SanitizeHtml = (dirty: string, options: SanitizeOptions) => string;

export interface RichImageRegistration {
  readonly resourceId: string;
  readonly alt: string | null;
}

export interface RichTextOptions {
  readonly baseUrl?: string | URL;
  readonly registerImage?: (url: string, alt: string | null) => RichImageRegistration | null | undefined;
  readonly maxInputChars?: number;
}

interface LinkFrame {
  readonly url: string;
  readonly parts: string[];
}

function sourceText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  let fallback = '';
  for (const key of ['displayText', 'rawText', 'text', 'content', 'description', 'body']) {
    if (typeof record[key] !== 'string') continue;
    if (!fallback) fallback = record[key];
    if (record[key].trim()) return record[key];
  }
  return fallback;
}

function conflictingBodySources(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const displayText = typeof record.displayText === 'string' ? record.displayText.trim() : '';
  const rawText = typeof record.rawText === 'string' ? record.rawText.trim() : '';
  return !!displayText && !!rawText && displayText !== rawText;
}

function unknownBodyShape(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length === 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const record = value as Record<string, unknown>;
  return !['displayText', 'rawText', 'text', 'content', 'description', 'body']
    .some(key => typeof record[key] === 'string' && record[key].trim().length > 0);
}

function loadSanitizer(): SanitizeHtml | null {
  try {
    const require = createRequire(import.meta.url);
    const loaded = require('sanitize-html') as { default?: unknown } | unknown;
    const candidate = loaded && typeof loaded === 'object' && 'default' in loaded ? loaded.default : loaded;
    return typeof candidate === 'function' ? candidate as SanitizeHtml : null;
  } catch {
    // The owner adds sanitize-html to the production manifest. A missing
    // dependency must degrade to incomplete text rather than unsafe HTML.
    return null;
  }
}

function baseUrlOf(value: string | URL | undefined): URL | null {
  if (!value) return null;
  try {
    const url = value instanceof URL ? new URL(value.href) : new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function safeLink(value: string | undefined, base: URL | null): string | null {
  if (!value || !base) return null;
  try {
    const url = new URL(value, base);
    if (url.username || url.password || url.port || url.hash) return null;
    if (url.protocol !== 'https:' && url.protocol !== 'mailto:') return null;
    if (url.protocol === 'https:') {
      for (const [key] of url.searchParams) if (SENSITIVE_LINK_QUERY.test(key)) return null;
      return url.href;
    }
    return `mailto:${url.pathname}`;
  } catch {
    return null;
  }
}

function safeImage(value: string | undefined, base: URL | null): string | null {
  if (!value || !base) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || url.origin !== CLASSIC_API_ORIGIN || url.username || url.password || url.port || url.hash) return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalizedText(value: string): string {
  return value
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// sanitize-html's textFilter receives text already escaped for safe HTML
// output. Decode that one presentation layer before building the plain-text
// summary; this is entity decoding, not HTML parsing or sanitization.
function decodeEscapedText(value: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
    hellip: '…', mdash: '—', ndash: '–', copy: '©', reg: '®', trade: '™',
    times: '×', middot: '·', bull: '•', laquo: '«', raquo: '»', euro: '€',
    yen: '¥', pound: '£', cent: '¢', deg: '°', plusmn: '±', sect: '§', para: '¶',
  };
  return value.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]{1,31}));/gi, (whole, decimal, hex, name) => {
    if (decimal !== undefined || hex !== undefined) {
      const point = Number.parseInt(decimal ?? hex, decimal !== undefined ? 10 : 16);
      if (Number.isInteger(point) && point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)) {
        try { return String.fromCodePoint(point); } catch { return whole; }
      }
      return whole;
    }
    return named[String(name).toLowerCase()] ?? whole;
  });
}

function appendBoundary(parts: string[]): void {
  const last = parts[parts.length - 1];
  if (last && !last.endsWith('\n')) parts.push('\n');
}

function resourceUrl(resourceId: string): string | null {
  if (!/^[A-Za-z0-9._:-]{1,300}$/.test(resourceId)) return null;
  return `lms-resource://resource/${encodeURIComponent(resourceId)}`;
}

/**
 * Parse and sanitize Blackboard rich text with an HTML parser. Remote images
 * are registered as opaque main-process resources; their signed URL never
 * enters the returned HTML or renderer DTO.
 */
export function sanitizeRichBody(value: unknown, options: RichTextOptions = {}): RichBody {
  const input = sourceText(value);
  const maxInput = Math.max(1, Math.min(MAX_INPUT_CHARS, options.maxInputChars ?? MAX_INPUT_CHARS));
  const truncatedInput = input.length > maxInput;
  const dirty = truncatedInput ? input.slice(0, maxInput) : input;
  const base = baseUrlOf(options.baseUrl) ?? new URL(CLASSIC_API_ORIGIN);
  const sanitizer = loadSanitizer();
  if (!sanitizer) return { text: normalizedText(dirty), sanitizedHtml: null, images: [], links: [], complete: false };

  const images: RichImageRegistration[] = [];
  const imageByUrl = new Map<string, RichImageRegistration>();
  const links: Array<{ label: string; url: string }> = [];
  const linkFrames: LinkFrame[] = [];
  const textParts: string[] = [];
  let incomplete = truncatedInput || conflictingBodySources(value) || unknownBodyShape(value);
  let boundaryPending = false;

  const addText = (valueToAdd: string): void => {
    if (!valueToAdd) return;
    if (boundaryPending && textParts.length) appendBoundary(textParts);
    boundaryPending = false;
    textParts.push(valueToAdd);
    for (const frame of linkFrames) frame.parts.push(valueToAdd);
  };

  const transformTags: SanitizeOptions['transformTags'] = {
    a: (_tagName: string, attribs: Attributes): TransformResult => {
      const href = safeLink(attribs.href, base);
      if (!href) {
        incomplete = true;
        return { tagName: 'span', attribs: {} };
      }
      return { tagName: 'a', attribs: { href } };
    },
    img: (_tagName: string, attribs: Attributes): TransformResult => {
      const source = safeImage(attribs.src, base);
      const alt = typeof attribs.alt === 'string' ? attribs.alt.slice(0, 500) || null : null;
      if (!source || !options.registerImage) {
        incomplete = true;
        return { tagName: 'span', attribs: {} };
      }
      let registration = imageByUrl.get(source);
      if (!registration) {
        try { registration = options.registerImage(source, alt) ?? undefined; } catch { registration = undefined; }
        if (registration) imageByUrl.set(source, registration);
      }
      if (!registration || !resourceUrl(registration.resourceId)) {
        incomplete = true;
        return { tagName: 'span', attribs: {} };
      }
      if (images.length < MAX_IMAGES && !images.some(item => item.resourceId === registration!.resourceId)) images.push(registration);
      else if (images.length >= MAX_IMAGES) incomplete = true;
      return { tagName: 'img', attribs: { src: resourceUrl(registration.resourceId)!, alt: alt ?? '' } };
    },
  };

  let sanitized: string;
  try {
    sanitized = sanitizer(dirty, {
      allowedTags: [...ALLOWED_TAGS],
      allowedAttributes: {
        a: ['href', 'title'],
        img: ['src', 'alt', 'width', 'height'],
        table: ['cellpadding', 'cellspacing', 'border'],
        th: ['colspan', 'rowspan', 'scope'],
        td: ['colspan', 'rowspan'],
      },
      allowedSchemes: ['https', 'mailto', 'lms-resource'],
      allowedSchemesAppliedToAttributes: ['href', 'src'],
      allowProtocolRelative: false,
      transformTags,
      onOpenTag: (name, attribs) => {
        if (name === 'a') {
          const href = safeLink(attribs.href, base);
          if (href) linkFrames.push({ url: href, parts: [] });
          else incomplete = true;
        }
        if (BLOCK_TAGS.has(name)) boundaryPending = true;
      },
      onCloseTag: name => {
        if (name === 'a') {
          const frame = linkFrames.pop();
          if (frame) {
            const label = normalizedText(frame.parts.join(''));
            if (label && links.length < MAX_LINKS && !links.some(item => item.label === label && item.url === frame.url)) links.push({ label, url: frame.url });
            else if (links.length >= MAX_LINKS) incomplete = true;
          }
        }
        if (BLOCK_TAGS.has(name)) boundaryPending = true;
      },
      textFilter: (text, _tagName) => {
        addText(decodeEscapedText(text));
        return text;
      },
    });
  } catch {
    return { text: normalizedText(dirty), sanitizedHtml: null, images: [], links: [], complete: false };
  }

  const text = normalizedText(textParts.join(''));
  const sanitizedHtml = sanitized.length <= MAX_HTML_CHARS ? sanitized : null;
  if (!sanitizedHtml) incomplete = true;
  // Registration only creates an opaque handle. The caller must report an
  // actual bounded resource read separately before a body can be complete.
  if (images.length) incomplete = true;
  return {
    text: text.slice(0, MAX_INPUT_CHARS),
    sanitizedHtml,
    images: images.slice(0, MAX_IMAGES).map(image => ({ resourceId: image.resourceId, alt: image.alt })),
    links: links.slice(0, MAX_LINKS),
    complete: !incomplete,
  };
}

