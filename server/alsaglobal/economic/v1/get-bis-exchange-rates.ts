/**
 * RPC: getBisExchangeRates
 *
 * Read order:
 *   1. Seeded Redis cache (Railway).
 *   2. Direct BIS SDMX CSV fetch via _bis-direct.ts (self-host fallback).
 */

import type {
  ServerContext,
  GetBisExchangeRatesRequest,
  GetBisExchangeRatesResponse,
} from '../../../../src/generated/server/alsaglobal/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { fetchBisExchangeRatesDirect } from './_bis-direct';

const SEED_CACHE_KEY = 'economic:bis:eer:v1';

export async function getBisExchangeRates(
  _ctx: ServerContext,
  _req: GetBisExchangeRatesRequest,
): Promise<GetBisExchangeRatesResponse> {
  try {
    const cached = await getCachedJson(SEED_CACHE_KEY, true) as GetBisExchangeRatesResponse | null;
    if (cached?.rates?.length) return cached;
  } catch {
    // fall through
  }
  try {
    const rates = await fetchBisExchangeRatesDirect();
    return { rates };
  } catch (err) {
    console.warn('[getBisExchangeRates] BIS direct fetch failed:', (err as Error).message);
    return { rates: [] };
  }
}
