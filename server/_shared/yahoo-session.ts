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

// ─── Rate-limit awareness ────────────────────────────────────────────────────
// When Yahoo's getcrumb endpoint refuses us with 429, hammering it harder just
// extends the block. Once we see 429s, we mark the session as "throttled until
// T" and stop trying to acquire a NEW one until T — we keep returning the
// cookies-only session we already have. Also gates log spam so the console
// doesn't fill with the same line every 200ms.
let crumbThrottleUntil = 0;
const CRUMB_THROTTLE_MS = 5 * 60 * 1000;     // 5 min
let last429LogAt = 0;
let lastNullLogAt = 0;
const LOG_THROTTLE_MS = 60 * 1000;            // log at most once / minute / category
let throttleEnteredAnnounced = false;

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

/**
 * Merge multiple "Set-Cookie" header lists, deduping by cookie name. Later
 * sets win — that matches how a real browser stores cookies across hops.
 */
function mergeCookies(...lists: string[][]): string {
  const byName = new Map<string, string>();
  for (const list of lists) {
    for (const c of list) {
      const eq = c.indexOf('=');
      if (eq === -1) continue;
      byName.set(c.slice(0, eq), c);
    }
  }
  return [...byName.values()].join('; ');
}

/**
 * Robust Yahoo-session acquire — same playbook the yahoo-finance2 npm
 * package uses. Two-stage cookie priming + retry the crumb across both
 * query1 and query2. Returns a session even if only cookies came back
 * (the v8/chart endpoint works without crumb on many symbols).
 */
async function acquire(): Promise<YahooSession | null> {
  let cookies: string[] = [];

  // Step 1a — Try fc.yahoo.com first. This is the lightweight endpoint
  // yahoo-finance2 hits initially; it sets the federated-services cookie
  // chain that getcrumb wants.
  try {
    const r = await fetch('https://fc.yahoo.com/', {
      headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'], Accept: 'text/html' },
      signal: AbortSignal.timeout(6_000),
      redirect: 'manual',
    });
    cookies = cookies.concat(extractCookies(r));
  } catch (err) {
    console.warn(`[yahoo-session] fc.yahoo.com primer failed: ${(err as Error).message}`);
  }

  // Step 1b — Hit a real quote page to pick up the A1/A3/A1S cookie set.
  try {
    const r = await fetch('https://finance.yahoo.com/quote/AAPL/', {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(ACQUIRE_TIMEOUT_MS),
      redirect: 'follow',
    });
    cookies = cookies.concat(extractCookies(r));
  } catch (err) {
    console.warn(`[yahoo-session] finance.yahoo.com primer failed: ${(err as Error).message}`);
  }

  if (cookies.length === 0) {
    console.warn('[yahoo-session] no cookies from any source — network or Yahoo refusal');
    return null;
  }
  const cookie = mergeCookies(cookies);

  // Step 2 — Crumb. Try query1 first, then query2.
  //
  // CRITICAL: getcrumb is NOT a CORS endpoint. Sending Origin/Referer headers
  // (which we DO send for data calls) triggers a 406 Not Acceptable response.
  // Confirmed empirically: every variant without those headers returns 200
  // with a valid crumb in ~400ms; every variant with them returns 406. So
  // here we send the absolute minimum: User-Agent, Accept, Cookie.
  let crumb = '';
  let saw429 = false;
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v1/test/getcrumb`, {
        headers: {
          'User-Agent': API_HEADERS['User-Agent'],
          'Accept': '*/*',
          Cookie: cookie,
        },
        signal: AbortSignal.timeout(ACQUIRE_TIMEOUT_MS),
      });
      if (!r.ok) {
        if (r.status === 429) saw429 = true;
        continue;
      }
      const body = (await r.text()).trim();
      const isProbablyValid =
        body.length > 0 &&
        body.length <= 64 &&
        !body.includes('<') &&
        !body.startsWith('{') &&
        !body.startsWith('[') &&
        /^[A-Za-z0-9._\-/+=]+$/.test(body);
      if (isProbablyValid) {
        crumb = body;
        console.log(`[yahoo-session] crumb acquired from ${host}`);
        break;
      } else {
        console.warn(`[yahoo-session] ${host} crumb body looks wrong: ${body.slice(0, 80)}`);
      }
    } catch (err) {
      console.warn(`[yahoo-session] ${host} getcrumb fetch failed: ${(err as Error).message}`);
    }
  }

  // If both hosts said 429, set a 5-minute throttle so we don't keep banging
  // the door. The cookies-only session is still useful for the few Yahoo
  // endpoints that don't need a crumb, so we return it instead of null.
  if (!crumb && saw429) {
    crumbThrottleUntil = Date.now() + CRUMB_THROTTLE_MS;
    if (!throttleEnteredAnnounced) {
      console.warn(`[yahoo-session] getcrumb rate-limited by Yahoo (429). Pausing new acquisitions for ${CRUMB_THROTTLE_MS / 60000}min — existing session reused with cookies only.`);
      throttleEnteredAnnounced = true;
    }
  } else if (crumb) {
    // success → reset announcement so the next throttle event still logs once
    throttleEnteredAnnounced = false;
    console.log(`[yahoo-session] acquired (cookies: ${cookies.length} raw, crumb: "${crumb.slice(0, 12)}…")`);
  }

  const session: YahooSession = { cookie, crumb, acquiredAt: Date.now() };
  return session;
}

/**
 * Returns the current session, acquiring or refreshing as needed. Returns
 * null only on hard failure (network down, Yahoo banning the IP outright).
 * Concurrent callers share the same in-flight acquisition.
 */
export async function getYahooSession(forceRefresh = false): Promise<YahooSession | null> {
  const now = Date.now();
  if (!forceRefresh && cached && now - cached.acquiredAt < SESSION_TTL_MS) return cached;

  // Throttled: keep returning whatever session we have. Don't try to acquire
  // a fresh one — Yahoo's edge will just keep 429'ing us and we'll get nothing
  // new from it. The cookies-only session covers v8/chart for most symbols.
  if (now < crumbThrottleUntil && cached) return cached;

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
 *
 * BUT: if we're inside the crumb-throttle window, invalidating just causes
 * another doomed acquire attempt. So we skip invalidation while throttled —
 * the existing session stays cached until the throttle expires.
 */
export function invalidateYahooSession(): void {
  if (Date.now() < crumbThrottleUntil) return;
  cached = null;
}

/** Light, gated logging so the dev console doesn't fill with the same line
 *  every 200ms when Yahoo is throttling us. */
export function shouldLogYahooNull(): boolean {
  const now = Date.now();
  if (now - lastNullLogAt < LOG_THROTTLE_MS) return false;
  lastNullLogAt = now;
  return true;
}

/** Use sparingly — only when you want to surface a *new* 429 transition. */
export function shouldLog429(): boolean {
  const now = Date.now();
  if (now - last429LogAt < LOG_THROTTLE_MS) return false;
  last429LogAt = now;
  return true;
}

/**
 * True when Yahoo's crumb endpoint is rate-limiting us right now. Callers can
 * use this to SKIP Yahoo entirely and jump straight to fallbacks — saves the
 * 8s data-fetch timeout per symbol that would otherwise occur.
 */
export function isYahooSessionThrottled(): boolean {
  return Date.now() < crumbThrottleUntil;
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
  const primaryHost = opts.host ?? 'query2';
  const timeoutMs = opts.timeoutMs ?? 8_000;

  const session = await getYahooSession();
  if (!session) return null;

  /** Build the request URL for a given host, appending crumb if we have one. */
  const buildUrl = (host: 'query1' | 'query2', s: YahooSession) =>
    s.crumb
      ? `https://${host}.finance.yahoo.com${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}crumb=${encodeURIComponent(s.crumb)}`
      : `https://${host}.finance.yahoo.com${pathAndQuery}`;

  /** Single fetch attempt with the given session/host. Returns Response | null on network error. */
  const attempt = async (s: YahooSession, host: 'query1' | 'query2'): Promise<Response | null> => {
    try {
      return await fetch(buildUrl(host, s), {
        headers: { ...API_HEADERS, Cookie: s.cookie },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return null;
    }
  };

  // 1. Try primary host with current session.
  let res = await attempt(session, primaryHost);

  // 2. If primary returned a refusal status (401/403/429) — refresh session
  //    and try the *other* host. This dodges per-edge rate limits AND stale
  //    cookies in one move.
  const otherHost: 'query1' | 'query2' = primaryHost === 'query2' ? 'query1' : 'query2';
  if (!res || res.status === 401 || res.status === 403 || res.status === 429 || res.status === 404) {
    invalidateYahooSession();
    const fresh = await getYahooSession(true);
    if (fresh) {
      res = await attempt(fresh, otherHost);
      // 3. If even the other host failed with a refusal, try fresh on primary too.
      if (res && (res.status === 401 || res.status === 403 || res.status === 429)) {
        res = await attempt(fresh, primaryHost);
      }
    }
  }

  if (!res || !res.ok) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
