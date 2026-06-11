/**
 * RPC: getBisPolicyRates
 *
 * Read order:
 *   1. Seeded Redis cache (Railway).
 *   2. Direct BIS SDMX CSV fetch via _bis-direct.ts (self-host fallback).
 */

import type {
  ServerContext,
  GetBisPolicyRatesRequest,
  GetBisPolicyRatesResponse,
} from '../../../../src/generated/server/alsaglobal/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { fetchBisPolicyRatesDirect } from './_bis-direct';

const SEED_CACHE_KEY = 'economic:bis:policy:v1';

export async function getBisPolicyRates(
  _ctx: ServerContext,
  _req: GetBisPolicyRatesRequest,
): Promise<GetBisPolicyRatesResponse> {
  try {
    const cached = await getCachedJson(SEED_CACHE_KEY, true) as GetBisPolicyRatesResponse | null;
    if (cached?.rates?.length) return cached;
  } catch {
    // Redis unavailable — fall through
  }
  try {
    const rates = await fetchBisPolicyRatesDirect();
    return { rates };
  } catch (err) {
    console.warn('[getBisPolicyRates] BIS direct fetch failed:', (err as Error).message);
    return { rates: [] };
  }
}
