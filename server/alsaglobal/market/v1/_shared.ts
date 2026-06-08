/**
 * Shared helpers, types, and constants for the market service handler RPCs.
 */
import { CHROME_UA, finnhubGate, yahooGate } from '../../../_shared/constants';
import { fetchYahooJson } from '../../../_shared/yahoo-session';
import { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/relay';
export { getRelayBaseUrl, getRelayHeaders };
import cryptoConfig from '../../../../shared/crypto.json';
import stablecoinConfig from '../../../../shared/stablecoins.json';
export { parseStringArray } from '../../../_shared/parse-string-array';

// ========================================================================
// Constants
// ========================================================================

export const UPSTREAM_TIMEOUT_MS = 8_000;
const STOOQ_TIMEOUT_MS = 5_000; // Stooq often slow/blocked from VPS — fail fast

export function sanitizeSymbol(raw: string): string {
  return raw.trim().replace(/\s+/g, '').slice(0, 32).toUpperCase();
}

// ========================================================================
// Stooq fetcher — free, no auth, no rate-limit issues on Windows/Node.
// Works for US stocks (aapl.us), crypto (btcusd), and futures (gc.f).
// CSV format: Symbol,Date,Time,Open,High,Low,Close,Volume
// ========================================================================

function toStooqSymbol(sym: string): string {
  // Already in stooq form?
  if (/\.(us|f)$/i.test(sym) || /^[A-Z]+USD$/i.test(sym)) return sym.toLowerCase();
  // Yahoo crypto BTC-USD → btcusd
  if (/-USD$/i.test(sym)) return sym.toLowerCase().replace('-usd', 'usd');
  // Yahoo futures GC=F → gc.f
  if (/=F$/i.test(sym)) return sym.toLowerCase().replace('=f', '.f');
  // Yahoo forex EURUSD=X, USDJPY=X → eurusd, usdjpy (strip =X)
  if (/=X$/i.test(sym)) return sym.toLowerCase().replace('=x', '');
  // Yahoo index ^GSPC → ^spx (stooq uses different names — fall back to as-is)
  if (sym.startsWith('^')) return sym.toLowerCase();
  // Plain US stock ticker → AAPL.us
  if (/^[A-Z.]{1,5}$/i.test(sym)) return `${sym.toLowerCase()}.us`;
  return sym.toLowerCase();
}

// In-memory Stooq cache: symbol → { result, ts }
// Prevents rate-limiting when multiple panels request the same symbols rapidly.
const _stooqCache = new Map<string, { result: { price: number; change: number; sparkline: number[] } | null; ts: number }>();
const STOOQ_CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes for successful quotes
const STOOQ_NEG_TTL_MS = 20 * 1000; // 20s for failed/N/D — retry quickly after transient rate-limit

// Stooq is a Polish data provider — it carries US stocks/futures, a handful of
// Western indices, crypto, and forex. It does NOT carry symbols from these
// exchanges, and lookups for them hang the TCP connection until the 5s
// timeout fires. Bail before the network call to avoid the spam and the wait.
const STOOQ_UNSUPPORTED_SUFFIX = /\.(ns|bo|hk|ss|sz|sr|ta|ca|is|ks|kq|tw|two|jk|ps|jo|bk|me|t|si)$/i;

function isStooqUnsupportedSymbol(rawSym: string): boolean {
  return STOOQ_UNSUPPORTED_SUFFIX.test(rawSym);
}

export async function fetchStooqQuote(
  symbol: string,
): Promise<{ price: number; change: number; sparkline: number[] } | null> {
  const stooqSym = toStooqSymbol(symbol);
  const now = Date.now();
  const hit = _stooqCache.get(stooqSym);
  // For null (failed) entries use STOOQ_NEG_TTL_MS so we retry quickly after transient N/D
  if (hit) {
    const ttl = hit.result !== null ? STOOQ_CACHE_TTL_MS : STOOQ_NEG_TTL_MS;
    if (now - hit.ts < ttl) return hit.result;
  }

  // Structural early-out: Stooq doesn't carry these exchanges, and requests
  // hang until the 5s timeout. Cheap to re-check via regex on every call.
  if (isStooqUnsupportedSymbol(symbol)) return null;

  try {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSym)}&f=sd2t2ohlcv&h&e=csv`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, 'Accept': 'text/csv' },
      signal: AbortSignal.timeout(STOOQ_TIMEOUT_MS),
    });
    if (!resp.ok) {
      _stooqCache.set(stooqSym, { result: null, ts: now });
      return null;
    }
    const csv = await resp.text();
    const lines = csv.trim().split('\n');
    if (lines.length < 2) { _stooqCache.set(stooqSym, { result: null, ts: now }); return null; }
    // Symbol,Date,Time,Open,High,Low,Close,Volume
    const cols = lines[1]!.split(',');
    if (cols.length < 7 || cols[3] === 'N/D' || cols[6] === 'N/D') {
      _stooqCache.set(stooqSym, { result: null, ts: now });
      return null;
    }
    const open = parseFloat(cols[3]!);
    const close = parseFloat(cols[6]!);
    if (!isFinite(open) || !isFinite(close) || close === 0) { _stooqCache.set(stooqSym, { result: null, ts: now }); return null; }
    const change = open > 0 ? ((close - open) / open) * 100 : 0;
    const result = { price: close, change, sparkline: [] };
    _stooqCache.set(stooqSym, { result, ts: now });
    return result;
  } catch {
    // Timeouts and aborts here are expected for symbols stooq doesn't carry —
    // cache the null and move on quietly.
    _stooqCache.set(stooqSym, { result: null, ts: now });
    return null;
  }
}

// ========================================================================
// Frankfurter forex fetcher — ECB reference rates, free, no key, no rate limit.
// Covers all major currency pairs via 2-3 cached calls per base currency.
// ========================================================================

// In-memory cache: base → { rates, fetchedAt }
const frankfurterCache = new Map<string, { rates: Record<string, number>; ts: number }>();
const FRANKFURTER_TTL_MS = 5 * 60 * 1000; // 5 min

async function fetchFrankfurterRates(base: string): Promise<Record<string, number> | null> {
  const now = Date.now();
  const hit = frankfurterCache.get(base);
  if (hit && now - hit.ts < FRANKFURTER_TTL_MS) return hit.rates;
  try {
    const resp = await fetch(`https://api.frankfurter.app/latest?from=${base}`, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const json = await resp.json() as { rates: Record<string, number> };
    frankfurterCache.set(base, { rates: json.rates, ts: now });
    return json.rates;
  } catch {
    return null;
  }
}

// EURUSD=X → base=EUR quote=USD; USDJPY=X → base=USD quote=JPY
function parseForexPair(yahooSym: string): { base: string; quote: string } | null {
  const clean = yahooSym.replace(/=X$/i, '').toUpperCase();
  if (clean.length === 6 && /^[A-Z]{6}$/.test(clean)) {
    return { base: clean.slice(0, 3), quote: clean.slice(3) };
  }
  return null;
}

async function fetchForexQuote(
  symbol: string,
): Promise<{ price: number; change: number; sparkline: number[] } | null> {
  const pair = parseForexPair(symbol);
  if (!pair) return null;
  const rates = await fetchFrankfurterRates(pair.base);
  if (!rates) return null;
  const price = rates[pair.quote];
  if (!price) return null;
  return { price, change: 0, sparkline: [] };
}

/**
 * Unified quote fetcher: Yahoo is primary (covers everything).
 *  - Yahoo first (cached, cookie-authed, with 429 backoff)
 *  - forex (=X) → Frankfurter fallback if Yahoo fails
 *  - others → Stooq fallback if Yahoo fails
 */
export async function fetchQuote(
  symbol: string,
): Promise<{ price: number; change: number; sparkline: number[] } | null> {
  // Yahoo first — primary source for everything
  const yahoo = await fetchYahooQuote(symbol);
  if (yahoo) return yahoo;

  // Forex fallback: Frankfurter (ECB rates)
  if (/=X$/i.test(symbol)) {
    const fx = await fetchForexQuote(symbol);
    if (fx) return fx;
  }

  // Stooq as last resort
  return fetchStooqQuote(symbol);
}

export async function fetchYahooQuotesBatch(
  symbols: string[],
): Promise<{ results: Map<string, { price: number; change: number; sparkline: number[] }>; rateLimited: boolean }> {
  const results = new Map<string, { price: number; change: number; sparkline: number[] }>();
  let rateLimitHits = 0;
  let consecutiveFails = 0;
  for (let i = 0; i < symbols.length; i++) {
    const q = await fetchYahooQuote(symbols[i]!);
    if (q) {
      results.set(symbols[i]!, q);
      consecutiveFails = 0;
    } else {
      rateLimitHits++;
      consecutiveFails++;
    }
    if (consecutiveFails >= 5) break;
  }
  return { results, rateLimited: rateLimitHits > symbols.length / 2 };
}

// Yahoo-only symbols: indices, futures, and forex pairs not on Finnhub free tier
export const YAHOO_ONLY_SYMBOLS = new Set([
  '^GSPC', '^DJI', '^IXIC', '^VIX',
  'GC=F', 'CL=F', 'NG=F', 'SI=F', 'HG=F',
  'EURUSD=X', 'GBPUSD=X', 'AUDUSD=X',
  'USDJPY=X', 'USDCNY=X', 'USDINR=X', 'USDCHF=X', 'USDCAD=X', 'USDTRY=X',
]);

export const CRYPTO_META: Record<string, { name: string; symbol: string }> = cryptoConfig.meta;

// ========================================================================
// Types
// ========================================================================

export interface YahooChartResponse {
  chart: {
    result: Array<{
      meta: {
        regularMarketPrice: number;
        chartPreviousClose?: number;
        previousClose?: number;
      };
      indicators?: {
        quote?: Array<{ close?: (number | null)[] }>;
      };
    }>;
  };
}

export interface CoinGeckoMarketItem {
  id: string;
  current_price: number;
  price_change_percentage_24h: number;
  sparkline_in_7d?: { price: number[] };
  // Extended fields (present from both CoinGecko and CoinPaprika fallback)
  price_change_percentage_7d_in_currency?: number;
  market_cap?: number;
  total_volume?: number;
  symbol?: string;
  name?: string;
  image?: string;
}

// ========================================================================
// Alpha Vantage fetchers
// ========================================================================

// Physical commodity function names for Alpha Vantage (no futures notation needed)
export const AV_PHYSICAL_COMMODITY_MAP: Record<string, string> = {
  'CL=F': 'WTI',
  'BZ=F': 'BRENT',
  'NG=F': 'NATURAL_GAS',
  'HG=F': 'COPPER',
  'ALI=F': 'ALUMINUM',
  'GC=F': 'GOLD',
  'SI=F': 'SILVER',
};

export async function fetchAlphaVantageQuotesBatch(
  symbols: string[],
  apiKey: string,
): Promise<Map<string, { price: number; change: number; sparkline: number[] }>> {
  const results = new Map<string, { price: number; change: number; sparkline: number[] }>();
  const BATCH = 100;
  const AV_BATCH_DELAY_MS = 500;
  for (let i = 0; i < symbols.length; i += BATCH) {
    if (i > 0) await new Promise<void>(r => setTimeout(r, AV_BATCH_DELAY_MS));
    const chunk = symbols.slice(i, i + BATCH);
    const url = `https://www.alphavantage.co/query?function=REALTIME_BULK_QUOTES&symbol=${encodeURIComponent(chunk.join(','))}&apikey=${encodeURIComponent(apiKey)}`;
    let resp: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) await new Promise<void>(r => setTimeout(r, 1000));
        resp = await fetch(url, {
          headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        break;
      } catch (err) {
        console.warn(`[AV] Bulk quotes fetch error (attempt ${attempt + 1}):`, (err as Error).message);
      }
    }
    if (!resp) continue;
    if (!resp.ok) {
      console.warn(`[AV] Bulk quotes HTTP ${resp.status}`);
      continue;
    }
    try {
      const json = await resp.json() as { data?: Array<{ symbol: string; price: string; 'previous close': string; 'change percent': string }>; Information?: string };
      if (json.Information) {
        const remaining = symbols.length - i - chunk.length;
        console.warn(`[AV] Rate limit hit${remaining > 0 ? ` — dropping ${remaining} remaining symbols` : ''}: ${json.Information.slice(0, 80)}`);
        break;
      }
      if (!Array.isArray(json.data)) continue;
      for (const item of json.data) {
        const price = parseFloat(item.price);
        const prevClose = parseFloat(item['previous close']);
        const changePct = Number.isFinite(prevClose) && prevClose > 0
          ? ((price - prevClose) / prevClose) * 100
          : parseFloat((item['change percent'] || '0').replace('%', ''));
        if (Number.isFinite(price) && price > 0) {
          results.set(item.symbol, { price, change: Number.isFinite(changePct) ? changePct : 0, sparkline: [] });
        }
      }
    } catch (err) {
      console.warn(`[AV] Bulk quotes parse error:`, (err as Error).message);
    }
  }
  return results;
}

export async function fetchAlphaVantagePhysicalCommodity(
  yahooSymbol: string,
  apiKey: string,
): Promise<{ price: number; change: number; sparkline: number[] } | null> {
  const fn = AV_PHYSICAL_COMMODITY_MAP[yahooSymbol];
  if (!fn) return null;
  const url = `https://www.alphavantage.co/query?function=${fn}&interval=daily&apikey=${encodeURIComponent(apiKey)}`;
  let resp: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) await new Promise<void>(r => setTimeout(r, 1000));
      resp = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      break;
    } catch (err) {
      console.warn(`[AV] ${fn} fetch error (attempt ${attempt + 1}):`, (err as Error).message);
    }
  }
  if (!resp) return null;
  if (!resp.ok) {
    console.warn(`[AV] ${fn} HTTP ${resp.status}`);
    return null;
  }
  try {
    const json = await resp.json() as { data?: Array<{ date: string; value: string }>; Information?: string };
    if (json.Information) {
      console.warn(`[AV] Rate limit hit: ${json.Information.slice(0, 100)}`);
      return null;
    }
    const data = json.data;
    if (!Array.isArray(data) || data.length < 2) return null;
    const latest = parseFloat(data[0]!.value);
    const prev = parseFloat(data[1]!.value);
    if (!Number.isFinite(latest) || latest <= 0) return null;
    const change = Number.isFinite(prev) && prev > 0 ? ((latest - prev) / prev) * 100 : 0;
    // Build sparkline from last 7 daily closes (oldest → newest)
    const sparkline = data.slice(0, 7).map(d => parseFloat(d.value)).filter(Number.isFinite).reverse();
    return { price: latest, change, sparkline };
  } catch (err) {
    console.warn(`[AV] ${fn} parse error:`, (err as Error).message);
    return null;
  }
}

// ========================================================================
// Finnhub quote fetcher
// ========================================================================

export async function fetchFinnhubQuote(
  symbol: string,
  apiKey: string,
): Promise<{ symbol: string; price: number; changePercent: number } | null> {
  try {
    await finnhubGate();
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA, 'X-Finnhub-Token': apiKey },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[Finnhub] ${symbol} HTTP ${resp.status}`);
      return null;
    }

    const data = await resp.json() as { c: number; d: number; dp: number; h: number; l: number; o: number; pc: number; t: number };
    if (data.c === 0 && data.h === 0 && data.l === 0) {
      console.warn(`[Finnhub] ${symbol} returned zeros (market closed or invalid)`);
      return null;
    }

    return { symbol, price: data.c, changePercent: data.dp };
  } catch (err) {
    console.warn(`[Finnhub] ${symbol} error:`, (err as Error).message);
    return null;
  }
}

// ========================================================================
// Yahoo Finance quote fetcher
// ========================================================================
// TODO: Add Financial Modeling Prep (FMP) as Yahoo Finance fallback.
//
// FMP API docs: https://site.financialmodelingprep.com/developer/docs
// Auth: API key required — env var FMP_API_KEY
// Free tier: 250 requests/day (paid tiers for higher volume)
//
// Endpoint mapping (Yahoo → FMP):
//   Quote:      /stable/quote?symbol=AAPL           (batch: comma-separated)
//   Indices:    /stable/quote?symbol=^GSPC           (^GSPC, ^DJI, ^IXIC supported)
//   Commodities:/stable/quote?symbol=GCUSD           (gold=GCUSD, oil=CLUSD, etc.)
//   Forex:      /stable/batch-forex-quotes            (JPY/USD pairs)
//   Crypto:     /stable/batch-crypto-quotes           (BTC, ETH, etc.)
//   Sparkline:  /stable/historical-price-eod/light?symbol=AAPL  (daily close)
//   Intraday:   /stable/historical-chart/1min?symbol=AAPL
//
// Symbol mapping needed:
//   ^GSPC → ^GSPC (same), ^VIX → ^VIX (same)
//   GC=F → GCUSD, CL=F → CLUSD, NG=F → NGUSD, SI=F → SIUSD, HG=F → HGUSD
//   JPY=X → JPYUSD (forex pair format differs)
//   BTC-USD → BTCUSD
//
// Implementation plan:
//   1. Add FMP_API_KEY to SUPPORTED_SECRET_KEYS in main.rs + settings UI
//   2. Create fetchFMPQuote() here returning same shape as fetchYahooQuote()
//   3. fetchYahooQuote() tries Yahoo first → on 429/failure, tries FMP if key exists
//   4. economic/_shared.ts fetchJSON() same fallback for Yahoo chart URLs
//   5. get-macro-signals.ts needs chart data (1y range) — use /stable/historical-price-eod/light
// ========================================================================

function parseYahooChartResponse(data: YahooChartResponse): { price: number; change: number; sparkline: number[] } | null {
  const result = data.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta) return null;

  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose || meta.previousClose || price;
  const change = ((price - prevClose) / prevClose) * 100;

  const closes = result.indicators?.quote?.[0]?.close;
  const sparkline = closes?.filter((v): v is number => v != null) || [];

  return { price, change, sparkline };
}

// ─── Yahoo quote cache ──────────────────────────────────────────────────────
// Most panels poll quotes every 30-60s; cache reduces upstream load 10x and
// effectively eliminates 429s during normal use.
const _yahooCache = new Map<string, { result: { price: number; change: number; sparkline: number[] } | null; ts: number }>();
const YAHOO_CACHE_TTL_MS = 90 * 1000;       // 90s for successful quotes
const YAHOO_NEG_TTL_MS = 30 * 1000;         // 30s for failures — retry sooner

/**
 * Fetch a Yahoo Finance quote using the shared session (cookie + crumb).
 * This is the canonical data path now — Yahoo authenticated this way returns
 * stocks, crypto, forex, indices, futures, AND international (.NS, .HK, etc.)
 * from any environment without 429-ing.
 */
export async function fetchYahooQuote(
  symbol: string,
): Promise<{ price: number; change: number; sparkline: number[] } | null> {
  const now = Date.now();
  const hit = _yahooCache.get(symbol);
  if (hit) {
    const ttl = hit.result !== null ? YAHOO_CACHE_TTL_MS : YAHOO_NEG_TTL_MS;
    if (now - hit.ts < ttl) return hit.result;
  }

  await yahooGate();

  const data = await fetchYahooJson<YahooChartResponse>(
    `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
    { host: 'query2', timeoutMs: UPSTREAM_TIMEOUT_MS },
  );
  if (data) {
    const parsed = parseYahooChartResponse(data);
    if (parsed) {
      _yahooCache.set(symbol, { result: parsed, ts: Date.now() });
      return parsed;
    }
    console.warn(`[Yahoo] ${symbol}: payload returned but no regularMarketPrice — symbol may be unknown`);
  } else {
    console.warn(`[Yahoo] ${symbol}: session/fetch returned null. Restart dev server with NODE_OPTIONS=--max-http-header-size=65536 if you see this on every symbol.`);
  }

  // Optional relay fallback (only if WS_RELAY_URL is set in env)
  const relayBase = getRelayBaseUrl();
  if (relayBase) {
    try {
      const resp = await fetch(`${relayBase}/yahoo-chart?symbol=${encodeURIComponent(symbol)}`, {
        headers: getRelayHeaders(),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (resp.ok) {
        const relayData: YahooChartResponse = await resp.json();
        const parsed = parseYahooChartResponse(relayData);
        if (parsed) {
          _yahooCache.set(symbol, { result: parsed, ts: Date.now() });
          return parsed;
        }
      }
    } catch {
      // relay is optional — fall through to null
    }
  }

  _yahooCache.set(symbol, { result: null, ts: Date.now() });
  return null;
}

// ========================================================================
// CoinGecko fetcher
// ========================================================================

// ─── In-memory CoinGecko cache (2 min TTL) ──────────────────────────────────
// Prevents hitting the free-tier rate limit (10-30 req/min) when multiple
// panels request crypto data within the same minute.

const _cgCache = new Map<string, { data: CoinGeckoMarketItem[]; ts: number }>();
const CG_CACHE_TTL_MS = 90_000; // 90 seconds

function _cgCacheKey(ids: string[]): string {
  return [...ids].sort().join(',');
}

export async function fetchCoinGeckoMarkets(
  ids: string[],
): Promise<CoinGeckoMarketItem[]> {
  const cacheKey = _cgCacheKey(ids);
  const cached = _cgCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CG_CACHE_TTL_MS) {
    return cached.data;
  }

  const apiKey = process.env.COINGECKO_API_KEY;
  const baseUrl = apiKey
    ? 'https://pro-api.coingecko.com/api/v3'
    : 'https://api.coingecko.com/api/v3';
  const url = `${baseUrl}/coins/markets?vs_currency=usd&ids=${ids.join(',')}&order=market_cap_desc&sparkline=true&price_change_percentage=24h,7d`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': CHROME_UA,
  };
  if (apiKey) headers['x-cg-pro-api-key'] = apiKey;

  const resp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`CoinGecko HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  if (!Array.isArray(data)) {
    throw new Error(`CoinGecko returned non-array: ${JSON.stringify(data).slice(0, 200)}`);
  }

  // Clean old cache entries to prevent memory leak
  if (_cgCache.size > 20) {
    const now = Date.now();
    for (const [k, v] of _cgCache) {
      if (now - v.ts > CG_CACHE_TTL_MS * 2) _cgCache.delete(k);
    }
  }

  _cgCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

// ========================================================================
// CoinPaprika fallback fetcher
// ========================================================================

// CoinGecko ID → CoinPaprika ID mapping — all token categories combined.
import aiTokenConfig from '../../../../shared/ai-tokens.json';
import defiTokenConfig from '../../../../shared/defi-tokens.json';
import otherTokenConfig from '../../../../shared/other-tokens.json';

const COINPAPRIKA_ID_MAP: Record<string, string> = {
  ...cryptoConfig.coinpaprika,
  ...stablecoinConfig.coinpaprika,
  ...(aiTokenConfig.coinpaprika as Record<string, string>),
  ...(defiTokenConfig.coinpaprika as Record<string, string>),
  ...(otherTokenConfig.coinpaprika as Record<string, string>),
};

interface CoinPaprikaTicker {
  id: string;
  name: string;
  symbol: string;
  quotes: {
    USD: {
      price: number;
      volume_24h: number;
      market_cap: number;
      percent_change_24h: number;
      percent_change_7d: number;
    };
  };
}

// CoinPaprika all-tickers cache: the endpoint returns ~3000 coins at once.
// Share it across all panel calls within the same TTL window.
let _cpCache: { data: CoinPaprikaTicker[]; ts: number } | null = null;
const CP_CACHE_TTL_MS = 90_000;

async function fetchCoinPaprikaAllTickers(): Promise<CoinPaprikaTicker[]> {
  if (_cpCache && Date.now() - _cpCache.ts < CP_CACHE_TTL_MS) {
    return _cpCache.data;
  }
  const resp = await fetch('https://api.coinpaprika.com/v1/tickers?quotes=USD', {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`CoinPaprika HTTP ${resp.status}`);
  const data: CoinPaprikaTicker[] = await resp.json();
  _cpCache = { data, ts: Date.now() };
  return data;
}

export async function fetchCoinPaprikaMarkets(
  geckoIds: string[],
): Promise<CoinGeckoMarketItem[]> {
  const paprikaIds = geckoIds.map(id => COINPAPRIKA_ID_MAP[id]).filter(Boolean);
  if (paprikaIds.length === 0) throw new Error('No CoinPaprika ID mapping for requested coins');

  const allTickers = await fetchCoinPaprikaAllTickers();
  const paprikaSet = new Set(paprikaIds);
  const matched = allTickers.filter(t => paprikaSet.has(t.id));

  const reverseMap = new Map(Object.entries(COINPAPRIKA_ID_MAP).map(([g, p]) => [p, g]));

  return matched.map(t => {
    const q = t.quotes.USD;
    return {
      id: reverseMap.get(t.id) || t.id,
      current_price: q.price,
      price_change_percentage_24h: q.percent_change_24h,
      price_change_percentage_7d_in_currency: q.percent_change_7d,
      market_cap: q.market_cap,
      total_volume: q.volume_24h,
      symbol: t.symbol.toLowerCase(),
      name: t.name,
      image: '',
      sparkline_in_7d: undefined,
    };
  });
}

// ========================================================================
// Unified crypto market fetcher: CoinGecko → CoinPaprika fallback
// ========================================================================

export async function fetchCryptoMarkets(
  ids: string[],
): Promise<CoinGeckoMarketItem[]> {
  try {
    return await fetchCoinGeckoMarkets(ids);
  } catch (err) {
    console.warn(`[CoinGecko] Failed, falling back to CoinPaprika:`, (err as Error).message);
    return fetchCoinPaprikaMarkets(ids);
  }
}
