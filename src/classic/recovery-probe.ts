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
