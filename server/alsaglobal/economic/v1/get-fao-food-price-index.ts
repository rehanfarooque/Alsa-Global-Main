/**
 * RPC: getFaoFoodPriceIndex
 *
 * Read order:
 *   1. Seeded Redis cache (Railway path).
 *   2. Direct FAO public CSV fetch as no-Redis fallback. FAO publishes the
 *      Food Price Index as a free CSV updated on the first Friday of each
 *      month. Cached in-process for 24 hours (the index only changes monthly).
 *
 * Source: https://www.fao.org/media/docs/worldfoodsituationlibraries/default-document-library/food_price_indices_data.csv
 */

import type {
  ServerContext,
  GetFaoFoodPriceIndexRequest,
  GetFaoFoodPriceIndexResponse,
  FaoFoodPricePoint,
} from '../../../../src/generated/server/alsaglobal/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const SEED_CACHE_KEY = 'economic:fao-ffpi:v1';
const FAO_CSV_URL = 'https://www.fao.org/media/docs/worldfoodsituationlibraries/default-document-library/food_price_indices_data.csv';
const MONTHS_TO_KEEP = 12;
const FAO_TIMEOUT_MS = 15_000;
const MEM_TTL_MS = 24 * 60 * 60_000;
let _memCache: { result: GetFaoFoodPriceIndexResponse; ts: number } | null = null;

const EMPTY: GetFaoFoodPriceIndexResponse = {
  points: [],
  fetchedAt: '',
  currentFfpi: 0,
  momPct: 0,
  yoyPct: 0,
};

function parseVal(s: string | undefined): number {
  if (!s) return 0;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
}

async function fetchFaoDirect(): Promise<GetFaoFoodPriceIndexResponse> {
  if (_memCache && Date.now() - _memCache.ts < MEM_TTL_MS) return _memCache.result;

  const resp = await fetch(FAO_CSV_URL, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv,text/plain,*/*' },
    signal: AbortSignal.timeout(FAO_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`FAO CSV HTTP ${resp.status}`);

  const raw = await resp.text();
  const text = raw.startsWith('﻿') ? raw.slice(1) : raw;
  // Lines like "2024-11,127.5,123.2,..." — pick the data rows by the YYYY-MM prefix.
  const dataLines = text.split('\n').map((l) => l.trim()).filter((l) => /^\d{4}-\d{2},/.test(l));
  if (dataLines.length === 0) throw new Error('FAO CSV: no data rows found');

  const allPoints: FaoFoodPricePoint[] = dataLines.map((line) => {
    const [date, ffpi, meat, dairy, cereals, oils, sugar] = line.split(',').map((s) => s.trim());
    return {
      date: date ?? '',
      ffpi: parseVal(ffpi),
      meat: parseVal(meat),
      dairy: parseVal(dairy),
      cereals: parseVal(cereals),
      oils: parseVal(oils),
      sugar: parseVal(sugar),
    };
  });

  const recent = allPoints.slice(-(MONTHS_TO_KEEP + 1));
  if (recent.length < 2) throw new Error('FAO CSV: insufficient data rows');

  const last = recent[recent.length - 1]!;
  const prev = recent[recent.length - 2]!;
  const yearAgo = recent.length >= 13 ? recent[recent.length - 13]! : null;
  const momPct = prev.ffpi > 0
    ? +(((last.ffpi - prev.ffpi) / prev.ffpi) * 100).toFixed(2)
    : 0;
  const yoyPct = yearAgo && yearAgo.ffpi > 0
    ? +(((last.ffpi - yearAgo.ffpi) / yearAgo.ffpi) * 100).toFixed(2)
    : 0;
  const points = recent.slice(-MONTHS_TO_KEEP);

  const result: GetFaoFoodPriceIndexResponse = {
    points,
    fetchedAt: new Date().toISOString(),
    currentFfpi: last.ffpi,
    momPct,
    yoyPct,
  };
  _memCache = { result, ts: Date.now() };
  return result;
}

export async function getFaoFoodPriceIndex(
  _ctx: ServerContext,
  _req: GetFaoFoodPriceIndexRequest,
): Promise<GetFaoFoodPriceIndexResponse> {
  try {
    const cached = await getCachedJson(SEED_CACHE_KEY, true) as GetFaoFoodPriceIndexResponse | null;
    if (cached?.points?.length) return cached;
  } catch {
    // fall through
  }
  try {
    return await fetchFaoDirect();
  } catch (err) {
    console.warn('[getFaoFoodPriceIndex] FAO direct fetch failed:', (err as Error).message);
    return EMPTY;
  }
}
