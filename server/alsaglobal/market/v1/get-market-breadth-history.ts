/**
 * AlsaGlobal: GetMarketBreadthHistory — FRED API for S&P 500 history.
 *
 * pctAboveNd ≈ 50 + clamp(SPX_devFromSMA_Nd / 12, -40, 40)
 * When SPX is 12% above its 200d SMA → ~90% of stocks estimated above.
 * Data source: FRED series SP500 (daily, authoritative, no 429).
 */

import type {
  ServerContext,
  GetMarketBreadthHistoryRequest,
  GetMarketBreadthHistoryResponse,
  BreadthSnapshot,
} from '../../../../src/generated/server/alsaglobal/market/v1/service_server';
import { CHROME_UA } from '../../../_shared/constants';

const FRED_TIMEOUT_MS = 12_000;

async function fetchFredSeries(seriesId: string, apiKey: string, days: number): Promise<{ date: string; close: number }[]> {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&observation_start=${startDate}&frequency=d&api_key=${encodeURIComponent(apiKey)}&file_type=json`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(FRED_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`FRED ${seriesId} HTTP ${resp.status}`);

  const json = await resp.json() as { observations?: Array<{ date: string; value: string }> };
  return (json.observations ?? [])
    .filter((o) => o.value !== '.' && o.value !== '')
    .map((o) => ({ date: o.date, close: parseFloat(o.value) }))
    .filter((o) => Number.isFinite(o.close) && o.close > 0);
}

function sma(prices: number[], period: number, idx: number): number | null {
  if (idx < period - 1) return null;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) sum += prices[i]!;
  return sum / period;
}

function devToPct(dev: number): number {
  const pct = 50 + Math.round((dev / 0.12) * 40);
  return Math.max(5, Math.min(95, pct));
}

export async function getMarketBreadthHistory(
  _ctx: ServerContext,
  _req: GetMarketBreadthHistoryRequest,
): Promise<GetMarketBreadthHistoryResponse> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    console.warn('[MarketBreadth] FRED_API_KEY not set');
    return { updatedAt: '', history: [], unavailable: true };
  }

  try {
    const history = await fetchFredSeries('SP500', apiKey, 280);
    if (history.length < 30) {
      return { updatedAt: '', history: [], unavailable: true };
    }

    const closes = history.map((h) => h.close);
    const snapshots: BreadthSnapshot[] = [];

    for (let i = 0; i < closes.length; i++) {
      const price = closes[i]!;
      const sma20 = sma(closes, 20, i);
      const sma50 = sma(closes, 50, i);
      const sma200 = sma(closes, 200, i);

      const snap: BreadthSnapshot = { date: history[i]!.date };
      if (sma20 !== null) snap.pctAbove20d = devToPct((price - sma20) / sma20);
      if (sma50 !== null) snap.pctAbove50d = devToPct((price - sma50) / sma50);
      if (sma200 !== null) snap.pctAbove200d = devToPct((price - sma200) / sma200);
      snapshots.push(snap);
    }

    const last = snapshots[snapshots.length - 1]!;
    return {
      currentPctAbove20d: last.pctAbove20d,
      currentPctAbove50d: last.pctAbove50d,
      currentPctAbove200d: last.pctAbove200d,
      updatedAt: new Date().toISOString(),
      history: snapshots,
      unavailable: false,
    };
  } catch (err) {
    console.warn('[MarketBreadth] calculation failed:', (err as Error).message);
    return { updatedAt: '', history: [], unavailable: true };
  }
}
