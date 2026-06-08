/**
 * Yahoo Finance session manager.
 *
 * Acquires and refreshes the cookie + crumb pair that Yahoo's edge requires
 * to serve data without 429-ing. This is the same dance yfinance, yahoo-fin,
 * and node-yahoo-finance2 use — without it, Yahoo blocks unauthenticated
 * requests within seconds.
 *
 * Lifecycle:
 *   1. GET https://finance.yahoo.com/quote/AAPL  → Set-Cookie: A1, A3, A1S
 *   2. GET https://query1.finance.yahoo.com/v1/test/getcrumb  (with cookies)
 *      → returns the crumb string
 *   3. Use both on every v8/v7/v10 data call:
 *        Cookie: A1=…; A3=…; A1S=…
 *        ?crumb=<crumb>
 *
 * Refreshed every 60 min. Auto-refreshed once on a 401/403/429 retry.
 *
 * NOTE: Yahoo's response headers can exceed Node's default 8 KB buffer
 * during the consent flow. The dev script sets NODE_OPTIONS=--max-http-header-size=65536
 * to handle that. If you see HeadersOverflowError, that's why.
 */

import { CHROME_UA } from './constants';

const SESSION_TTL_MS = 60 * 60 * 1000; // 60 minutes
const ACQUIRE_TIMEOUT_MS = 12_000;

export interface YahooSession {
  cookie: string;
  /** Empty string if Yahoo returned a malformed crumb. Data endpoints (chart, etc.)
   *  work with cookies alone; crumb is only required for quoteSummary, options, search. */
  crumb: string;
  acquiredAt: number;
}

let cached: YahooSession | null = null;
let inFlight: Promise<YahooSession | null> | null = null;

const BROWSER_HEADERS = {
  'User-Agent': CHROME_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

const API_HEADERS = {
  'User-Agent': CHROME_UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
};

function extractCookies(res: Response): string[] {
  // Node 22+ supports getSetCookie(); fall back to single-value getter.
  const h = res.headers as unknown as { getSetCookie?: () => string[] };
  const raw = h.getSetCookie?.() ?? (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
  return raw.map((c) => c.split(';')[0]!.trim()).filter(Boolean);
}

async function acquire(): Promise<YahooSession | null> {
  try {
    // Step 1 — prime cookies. The /quote/<sym> page is what real browsers
    // hit first and triggers the auth cookie set we need.
    const r1 = await fetch('https://finance.yahoo.com/quote/AAPL', {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(ACQUIRE_TIMEOUT_MS),
      redirect: 'follow',
    });
    let cookies = extractCookies(r1);
    // Dedup by cookie name; later sets overwrite earlier ones.
    const byName = new Map<string, string>();
    for (const c of cookies) byName.set(c.split('=')[0]!, c);
    cookies = [...byName.values()];
    if (cookies.length === 0) {
      console.warn('[yahoo-session] no cookies returned by finance.yahoo.com');
      return null;
    }
    const cookie = cookies.join('; ');

    // Step 2 — exchange the cookies for a crumb token.
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...API_HEADERS, Cookie: cookie },
      signal: AbortSignal.timeout(ACQUIRE_TIMEOUT_MS),
    });
    // A real crumb is a short alphanumeric token (~11 chars). Anything else —
    // HTML page, JSON error body, oversize blob — means Yahoo refused this leg
    // but the cookies are still valid for data endpoints. Treat as empty crumb
    // rather than failing the whole session.
    let crumb = '';
    if (r2.ok) {
      const body = (await r2.text()).trim();
      const isProbablyValid =
        body.length > 0 &&
        body.length <= 64 &&
        !body.includes('<') &&
        !body.startsWith('{') &&
        !body.startsWith('[') &&
        /^[A-Za-z0-9._\-/+=]+$/.test(body);
      if (isProbablyValid) crumb = body;
    }

    const session: YahooSession = { cookie, crumb, acquiredAt: Date.now() };
    console.log(`[yahoo-session] acquired (cookies: ${cookies.length}, crumb: ${crumb ? `"${crumb.slice(0, 12)}…"` : 'none — using cookies only'})`);
    return session;
  } catch (err) {
    console.warn(`[yahoo-session] acquisition failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Returns the current session, acquiring or refreshing as needed. Returns
 * null only on hard failure (network down, Yahoo banning the IP outright).
 * Concurrent callers share the same in-flight acquisition.
 */
export async function getYahooSession(forceRefresh = false): Promise<YahooSession | null> {
  const now = Date.now();
  if (!forceRefresh && cached && now - cached.acquiredAt < SESSION_TTL_MS) return cached;
  if (inFlight) return inFlight;
  inFlight = acquire().then((s) => {
    cached = s;
    inFlight = null;
    return s;
  });
  return inFlight;
}

/**
 * Invalidate the cached session. Called on 401/403/429 so the next request
 * triggers a fresh acquire instead of retrying with the bad token.
 */
export function invalidateYahooSession(): void {
  cached = null;
}

/**
 * Convenience: fetch a Yahoo JSON endpoint with session + crumb in one call.
 * Handles a single auto-refresh on 401/403/429. Returns null on failure.
 *
 * The endpoint should be the path AFTER the host, e.g.
 *   `/v8/finance/chart/AAPL?interval=1d&range=5d`
 * The crumb is appended automatically.
 */
export async function fetchYahooJson<T = unknown>(
  pathAndQuery: string,
  opts: { host?: 'query1' | 'query2'; timeoutMs?: number } = {},
): Promise<T | null> {
  const host = opts.host ?? 'query2';
  const timeoutMs = opts.timeoutMs ?? 8_000;

  const session = await getYahooSession();
  if (!session) return null;

  // Only append crumb if we actually have one. v8/finance/chart works with
  // cookies alone; only v10/quoteSummary and v7/options strictly require it.
  const url = session.crumb
    ? `${`https://${host}.finance.yahoo.com${pathAndQuery}`}${pathAndQuery.includes('?') ? '&' : '?'}crumb=${encodeURIComponent(session.crumb)}`
    : `https://${host}.finance.yahoo.com${pathAndQuery}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { ...API_HEADERS, Cookie: session.cookie },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }

  // Stale session — refresh once and retry once.
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    invalidateYahooSession();
    const fresh = await getYahooSession(true);
    if (!fresh) return null;
    const retryUrl = fresh.crumb
      ? `${`https://${host}.finance.yahoo.com${pathAndQuery}`}${pathAndQuery.includes('?') ? '&' : '?'}crumb=${encodeURIComponent(fresh.crumb)}`
      : `https://${host}.finance.yahoo.com${pathAndQuery}`;
    try {
      res = await fetch(retryUrl, {
        headers: { ...API_HEADERS, Cookie: fresh.cookie },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return null;
    }
  }

  if (!res.ok) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
