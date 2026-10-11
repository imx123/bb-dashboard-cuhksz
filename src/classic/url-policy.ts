import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { ClassicError } from './errors.js';

export const CLASSIC_ORIGIN = 'https://bb.cuhk.edu.cn';

function parse(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return undefined;
  try { return new URL(value); } catch { return undefined; }
}

export function isAllowedClassicUrl(value: unknown): value is string {
  const url = parse(value);
  return !!url && url.protocol === 'https:' && url.hostname.toLowerCase() === 'bb.cuhk.edu.cn' &&
    !url.username && !url.password && !url.port;
}

export function classicUrl(value: unknown): string | undefined {
  return isAllowedClassicUrl(value) ? new URL(value as string).href : undefined;
}

export function requireClassicUrl(value: unknown): string {
  const url = classicUrl(value);
  if (!url) throw new ClassicError('URL_REJECTED', '仅支持打开 bb.cuhk.edu.cn 的 HTTPS 页面。', { recoverable: false });
  return url;
}

export function courseUrl(courseId: string): string {
  if (!/^_\d+_\d+$/.test(courseId)) throw new ClassicError('BAD_INPUT', '课程 ID 无效。', { recoverable: false });
  return `${CLASSIC_ORIGIN}/webapps/blackboard/execute/launcher?type=Course&id=${encodeURIComponent(courseId)}&url=`;
}

export function safeFileName(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+$/, '_').trim();
  return (cleaned || 'blackboard-file').slice(0, 180);
}

export function safeDownloadPath(root: string, name: string): string {
  if (!isAbsolute(root)) throw new ClassicError('DOWNLOAD_FAILED', '下载目录必须是本机绝对路径。', { recoverable: false });
  const target = resolve(root, safeFileName(basename(name)));
  const rel = relative(resolve(root), target);
  if (rel.startsWith('..') || isAbsolute(rel) || dirname(target) !== resolve(root)) {
    throw new ClassicError('DOWNLOAD_FAILED', '下载文件名无效，已阻止目录穿越。', { recoverable: false });
  }
  return target;
}
