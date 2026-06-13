/**
 * RPC: getFredSeriesBatch -- reads seeded FRED data from Railway seed cache.
 * All external FRED API calls happen in seed-economy.mjs on Railway.
 */

import type {
  ServerContext,
  GetFredSeriesBatchRequest,
  GetFredSeriesBatchResponse,
  FredSeries,
} from '../../../../src/generated/server/alsaglobal/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { toUniqueSortedLimited } from '../../../_shared/normalize-list';
import { applyFredObservationLimit, fredSeedKey, normalizeFredLimit } from './_fred-shared';
import { CHROME_UA } from '../../../_shared/constants';

// Series fetchable live from the FRED API when the Redis seed is empty
// (self-host path). Everything in ALLOWED_SERIES is a real FRED series except
// the entries seeded from non-FRED pipelines: GSCPI (NY Fed via ais-relay)
// and the ECB short rates (ESTR / EURIBOR*, seeded by seed-ecb-short-rates).
const FRED_LIVE_EXCLUDED = new Set(['GSCPI', 'ESTR', 'EURIBOR3M', 'EURIBOR6M', 'EURIBOR1Y']);

const FRED_SERIES_META: Record<string, { title: string; units: string }> = {
  DGS1MO: { title: '1-Month Treasury', units: '%' },
  DGS3MO: { title: '3-Month Treasury', units: '%' },
  DGS6MO: { title: '6-Month Treasury', units: '%' },
  DGS1:   { title: '1-Year Treasury', units: '%' },
  DGS2:   { title: '2-Year Treasury', units: '%' },
  DGS5:   { title: '5-Year Treasury', units: '%' },
  DGS10:  { title: '10-Year Treasury', units: '%' },
  DGS30:  { title: '30-Year Treasury', units: '%' },
  VIXCLS: { title: 'CBOE Volatility Index', units: 'Index' },
  FEDFUNDS: { title: 'Federal Funds Rate', units: '%' },
  SOFR:   { title: 'Secured Overnight Financing Rate', units: '%' },
  T10Y2Y: { title: '10-Year minus 2-Year', units: '%' },
  T10Y3M: { title: '10-Year minus 3-Month', units: '%' },
  CPIAUCSL: { title: 'Consumer Price Index', units: 'Index' },
  UNRATE: { title: 'Unemployment Rate', units: '%' },
  GDP: { title: 'Gross Domestic Product', units: '$B' },
  M2SL: { title: 'M2 Money Stock', units: '$B' },
  WALCL: { title: 'Fed Balance Sheet', units: '$M' },
  DCOILWTICO: { title: 'WTI Crude Oil', units: '$/bbl' },
  BAMLH0A0HYM2: { title: 'High Yield OAS', units: '%' },
  BAMLC0A0CM: { title: 'IG Corporate OAS', units: '%' },
  ICSA: { title: 'Initial Jobless Claims', units: 'Claims' },
  MORTGAGE30US: { title: '30-Year Mortgage Rate', units: '%' },
  STLFSI4: { title: 'St. Louis Fed Financial Stress', units: 'Index' },
};

async function fetchFredSeriesLive(seriesId: string, apiKey: string, limit: number): Promise<FredSeries | null> {
  try {
    // sort_order=desc + limit returns exactly the last N observations
    // regardless of series frequency (daily, monthly, quarterly). The old
    // observation_start window assumed daily data, which starved monthly
    // series like CPIAUCSL (3 rows instead of the 13 needed for YoY).
    const fetchN = Math.max(limit, 14);
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&sort_order=desc&limit=${fetchN}&api_key=${encodeURIComponent(apiKey)}&file_type=json`;
    const resp = await fetch(url, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const json = await resp.json() as { observations?: Array<{ date: string; value: string }> };
    const observations = (json.observations ?? [])
      .filter(o => o.value !== '.' && o.value !== '')
      .map(o => ({ date: o.date, value: parseFloat(o.value) }))
      .reverse(); // desc → chronological
    if (observations.length === 0) return null;
    const meta = FRED_SERIES_META[seriesId] ?? { title: seriesId, units: '' };
    return { seriesId, title: meta.title, units: meta.units, frequency: 'd', observations };
  } catch {
    return null;
  }
}

const ALLOWED_SERIES = new Set<string>([
  'WALCL', 'FEDFUNDS', 'T10Y2Y', 'UNRATE', 'CPIAUCSL', 'DGS10', 'VIXCLS',
  'GDP', 'M2SL', 'DCOILWTICO', 'BAMLH0A0HYM2', 'ICSA', 'MORTGAGE30US',
  'GSCPI', // NY Fed Global Supply Chain Pressure Index (seeded by ais-relay, not FRED API)
  'T10Y3M', 'STLFSI4', // Economic Stress Index components (seeded by seed-economy.mjs)
  'DGS1MO', 'DGS3MO', 'DGS6MO', 'DGS1', 'DGS2', 'DGS5', 'DGS30', // yield curve tenors
  'BAMLC0A0CM', 'SOFR', // IG OAS spread + Secured Overnight Financing Rate (seeded by seed-economy.mjs)
  'ESTR', 'EURIBOR3M', 'EURIBOR6M', 'EURIBOR1Y', // ECB short rates (seeded by seed-ecb-short-rates.mjs)
]);

export async function getFredSeriesBatch(
  _ctx: ServerContext,
  req: GetFredSeriesBatchRequest,
): Promise<GetFredSeriesBatchResponse> {
  try {
    const normalized = req.seriesIds
      .map((id) => id.trim().toUpperCase())
      .filter((id) => ALLOWED_SERIES.has(id));
    const limitedList = toUniqueSortedLimited(normalized, 20);
    const limit = normalizeFredLimit(req.limit);

    const settled = await Promise.allSettled(
      limitedList.map((id) => getCachedJson(fredSeedKey(id), true)),
    );

    const results: Record<string, FredSeries> = {};
    for (let i = 0; i < limitedList.length; i++) {
      const id = limitedList[i]!;
      const entry = settled[i];
      if (entry?.status !== 'fulfilled' || !entry.value) continue;
      const cached = entry.value as { series?: FredSeries };
      if (cached?.series) results[id] = applyFredObservationLimit(cached.series, limit);
    }

    // If Redis returned no data, fall back to live FRED API for supported series
    const missingIds = limitedList.filter(id => !results[id] && !FRED_LIVE_EXCLUDED.has(id));
    if (missingIds.length > 0) {
      const fredKey = process.env.FRED_API_KEY;
      if (fredKey) {
        const liveResults = await Promise.allSettled(
          missingIds.map(id => fetchFredSeriesLive(id, fredKey, limit))
        );
        for (let i = 0; i < missingIds.length; i++) {
          const r = liveResults[i];
          if (r?.status === 'fulfilled' && r.value) {
            results[missingIds[i]!] = r.value;
          }
        }
      }
    }

    return {
      results,
      fetched: Object.keys(results).length,
      requested: limitedList.length,
    };
  } catch {
    return { results: {}, fetched: 0, requested: 0 };
  }
}
