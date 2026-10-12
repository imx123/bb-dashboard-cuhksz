/** Bounded, read-only recovery checks. No browser credentials are exposed. */
export async function boundedRecoveryRead<T>(read: () => Promise<T>, timeoutMs = 1200): Promise<
  { ok: true; value: T } | { ok: false; reason: 'timeout' | 'failed' }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read).then(value => ({ ok: true as const, value }), () => ({ ok: false as const, reason: 'failed' as const })),
      new Promise<{ ok: false; reason: 'timeout' }>(resolve => { timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function probeRecoveryIdentity(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<{ authenticated: boolean; status?: number; reason?: string }> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
  try {
    const response = await fetcher('https://bb.cuhk.edu.cn/learn/api/v1/users/me', {
      method: 'GET', credentials: 'include', redirect: 'error', signal: requestSignal,
    });
    if (response.status !== 200) { await response.body?.cancel(); return { authenticated: false, status: response.status }; }
    const reader = response.body?.getReader();
    if (!reader) return { authenticated: false, status: 200, reason: 'empty' };
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 32768) { await reader.cancel(); return { authenticated: false, status: 200, reason: 'oversize' }; }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const id = body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).id ?? (body as Record<string, unknown>).userId : null;
    return { authenticated: typeof id === 'string' && id.length > 0 && id.length <= 300, status: 200 };
  } catch { return { authenticated: false, reason: requestSignal.aborted ? 'aborted-or-timeout' : 'network-or-schema' }; }
}
