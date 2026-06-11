/**
 * RPC: getEcbFxRates
 *
 * Read order:
 *   1. Seeded Redis cache (Railway path) — full rates dict.
 *   2. Direct ECB Statistical Warehouse fetch as no-Redis fallback. ECB
 *      publishes a free CSV of daily EUR reference rates updated at 16:00
 *      CET; we pull the last 30 days for both today's quote and a 1-day
 *      change calculation. Cached in-process for 12 hours.
 *
 * Source: https://data-api.ecb.europa.eu/service/data/EXR
 *   Key: D.<CCY>.EUR.SP00.A (daily spot rate)
 */

import type {
  ServerContext,
  GetEcbFxRatesRequest,
  GetEcbFxRatesResponse,
  EcbFxRate,
} from '../../../../src/generated/server/alsaglobal/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const SEED_CACHE_KEY = 'economic:ecb-fx-rates:v1';

// Major pairs the EU yield-curve / macro panel renders. ECB quotes are EUR-based
// so each row is units of FX per 1 EUR.
const ECB_PAIRS = ['USD', 'GBP', 'JPY', 'CHF', 'CNY', 'INR', 'CAD', 'AUD', 'BRL', 'TRY', 'RUB', 'KRW', 'MXN'];

const ECB_BASE = 'https://data-api.ecb.europa.eu/service/data/EXR';
const ECB_TIMEOUT_MS = 12_000;
const MEM_TTL_MS = 12 * 60 * 60_000;
let _memCache: { result: GetEcbFxRatesResponse; ts: number } | null = null;

function buildFallback(): GetEcbFxRatesResponse {
  return { rates: [], updatedAt: '', seededAt: '0', unavailable: true };
}

async function fetchEcbDirect(): Promise<GetEcbFxRatesResponse> {
  if (_memCache && Date.now() - _memCache.ts < MEM_TTL_MS) return _memCache.result;

  // Window: last 14 calendar days so we always cover both the latest publication
  // day and the prior trading day, even across weekends.
  const since = new Date();
  since.setDate(since.getDate() - 14);
  const startDate = since.toISOString().slice(0, 10);

  const key = `D.${ECB_PAIRS.join('+')}.EUR.SP00.A`;
  const url = `${ECB_BASE}/${key}?startPeriod=${startDate}&format=csvdata`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv' },
    signal: AbortSignal.timeout(ECB_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`ECB HTTP ${resp.status}`);
  const csv = await resp.text();

  // CSV columns include CURRENCY, TIME_PERIOD, OBS_VALUE. Index the headers.
  const lines = csv.split('\n').filter((l) => l.trim());
  if (lines.length < 2) throw new Error('ECB returned empty CSV');
  const headers = lines[0]!.split(',').map((h) => h.replace(/^"|"$/g, '').trim());
  const idxCcy = headers.indexOf('CURRENCY');
  const idxDate = headers.indexOf('TIME_PERIOD');
  const idxVal = headers.indexOf('OBS_VALUE');
  if (idxCcy < 0 || idxDate < 0 || idxVal < 0) {
    throw new Error('ECB CSV missing expected columns');
  }

  // (ccy, date) -> value
  const byCcy = new Map<string, Array<{ date: string; value: number }>>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(',').map((c) => c.replace(/^"|"$/g, '').trim());
    const ccy = cols[idxCcy];
    const date = cols[idxDate];
    const val = Number(cols[idxVal]);
    if (!ccy || !date || !Number.isFinite(val)) continue;
    if (!byCcy.has(ccy)) byCcy.set(ccy, []);
    byCcy.get(ccy)!.push({ date, value: val });
  }

  const rates: EcbFxRate[] = [];
  let newestDate = '';
  for (const ccy of ECB_PAIRS) {
    const obs = byCcy.get(ccy);
    if (!obs || obs.length === 0) continue;
    obs.sort((a, b) => a.date.localeCompare(b.date));
    const latest = obs[obs.length - 1]!;
    const prev = obs.length >= 2 ? obs[obs.length - 2]! : null;
    const change1d = prev && prev.value > 0
      ? Math.round(((latest.value - prev.value) / prev.value) * 10000) / 100
      : 0;
    rates.push({
      pair: `EUR/${ccy}`,
      rate: latest.value,
      date: latest.date,
      change1d,
    });
    if (latest.date > newestDate) newestDate = latest.date;
  }

  if (rates.length === 0) throw new Error('ECB returned no usable rows');

  const result: GetEcbFxRatesResponse = {
    rates,
    updatedAt: newestDate,
    seededAt: String(Date.now()),
    unavailable: false,
  };
  _memCache = { result, ts: Date.now() };
  return result;
}

export async function getEcbFxRates(
  _ctx: ServerContext,
  _req: GetEcbFxRatesRequest,
): Promise<GetEcbFxRatesResponse> {
  try {
    const cached = await getCachedJson(SEED_CACHE_KEY, true) as {
      rates: Record<string, { rate: number; date: string; change1d: number }>;
      updatedAt: string;
      seededAt: number;
    } | null;

    if (cached?.rates && Object.keys(cached.rates).length > 0) {
      const rates: EcbFxRate[] = Object.entries(cached.rates).map(([pair, r]) => ({
        pair,
        rate: r.rate,
        date: r.date,
        change1d: r.change1d,
      }));
      return {
        rates,
        updatedAt: cached.updatedAt ?? '',
        seededAt: String(cached.seededAt ?? 0),
        unavailable: false,
      };
    }
  } catch {
    // fall through
  }
  try {
    return await fetchEcbDirect();
  } catch (err) {
    console.warn('[getEcbFxRates] ECB direct fetch failed:', (err as Error).message);
    return buildFallback();
  }
}
