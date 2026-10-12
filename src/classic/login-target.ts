/** Accept only a literal navigation target from the school's own login page. */
export function literalLoginTarget(handler: string): string | null {
  const match = /^\s*(?:window\.)?location\.href\s*=\s*\(?\s*(["'])([^"'\r\n]+)\1\s*\)?\s*;?\s*$/.exec(handler);
  return match?.[2] ?? null;
}

export function approvedLoginTarget(value: string, apiOrigin: string, origins: ReadonlySet<string>): string | null {
  if (value.length > 8000) return null;
  try {
    const target = new URL(value, apiOrigin);
    if (target.protocol !== 'https:' || target.username || target.password || target.port || target.hash || !origins.has(target.origin)) return null;
    if (target.origin === apiOrigin && /^\/auth-saml\/saml\/login(?:\/|$)/i.test(target.pathname)) return target.href;
    if (target.origin !== 'https://sts.cuhk.edu.cn' || !/^\/adfs\/oauth2\/authorize\/?$/i.test(target.pathname)) return null;
    if (target.searchParams.get('response_type') !== 'code' || target.searchParams.getAll('redirect_uri').length !== 1) return null;
    const callback = new URL(target.searchParams.get('redirect_uri') ?? '');
    if (callback.origin !== apiOrigin || callback.username || callback.password || callback.port || callback.search || callback.hash ||
        callback.pathname !== '/webapps/bb-SSOIntegrationOAuth2-BBLEARN/authValidate/getCode') return null;
    if (!/^[0-9a-f-]{36}$/i.test(target.searchParams.get('client_id') ?? '')) return null;
    return target.href;
  } catch { return null; }
}
