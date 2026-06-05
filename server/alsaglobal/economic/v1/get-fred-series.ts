/**
 * RPC: getFredSeries — FRED direct API with Railway seed cache fallback.
 */

import type {
  ServerContext,
  GetFredSeriesRequest,
  GetFredSeriesResponse,
  FredSeries,
  FredObservation,
} from '../../../../src/generated/server/alsaglobal/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { applyFredObservationLimit, fredSeedKey, normalizeFredLimit } from './_fred-shared';
import { CHROME_UA } from '../../../_shared/constants';

const FRED_BASE = 'https://api.stlouisfed.org/fred';
const TIMEOUT_MS = 12_000;
const FRED_CACHE_TTL_MS = 10 * 60 * 1000;
const _fredCache = new Map<string, { series: FredSeries; ts: number }>();

async function fetchFredDirect(seriesId: string, apiKey: string): Promise<FredSeries | null> {
  const hit = _fredCache.get(seriesId);
  if (hit && Date.now() - hit.ts < FRED_CACHE_TTL_MS) return hit.series;

  try {
    const qs = `series_id=${encodeURIComponent(seriesId)}&api_key=${apiKey}&file_type=json`;
    const [infoResp, obsResp] = await Promise.all([
      fetch(`${FRED_BASE}/series?${qs}`, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) }),
      fetch(`${FRED_BASE}/series/observations?${qs}&sort_order=asc&limit=200`, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) }),
    ]);
    if (!infoResp.ok || !obsResp.ok) return null;

    const [infoJson, obsJson] = await Promise.all([
      infoResp.json() as Promise<{ seriess?: Array<{ title: string; units: string; frequency: string }> }>,
      obsResp.json() as Promise<{ observations?: Array<{ date: string; value: string }> }>,
    ]);

    const info = infoJson.seriess?.[0];
    const observations: FredObservation[] = (obsJson.observations ?? [])
      .filter(o => o.value !== '.' && o.value !== '')
      .map(o => ({ date: o.date, value: parseFloat(o.value) }))
      .filter(o => isFinite(o.value));

    const series: FredSeries = {
      seriesId,
      title: info?.title ?? seriesId,
      units: info?.units ?? '',
      frequency: info?.frequency ?? '',
      observations,
    };
    _fredCache.set(seriesId, { series, ts: Date.now() });
    return series;
  } catch (err) {
    console.warn(`[FRED] ${seriesId} error:`, (err as Error).message);
    return null;
  }
}

export async function getFredSeries(
  _ctx: ServerContext,
  req: GetFredSeriesRequest,
): Promise<GetFredSeriesResponse> {
  if (!req.seriesId) return { series: undefined };
  const limit = normalizeFredLimit(req.limit);
  const apiKey = process.env.FRED_API_KEY;

  if (apiKey) {
    const series = await fetchFredDirect(req.seriesId, apiKey);
    if (series) return { series: applyFredObservationLimit(series, limit) };
  }

  try {
    const result = await getCachedJson(fredSeedKey(req.seriesId), true) as GetFredSeriesResponse | null;
    if (!result?.series) return { series: undefined };
    return { series: applyFredObservationLimit(result.series, limit) };
  } catch {
    return { series: undefined };
  }
}
