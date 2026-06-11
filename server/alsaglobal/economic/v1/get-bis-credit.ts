/**
 * RPC: getBisCredit
 *
 * Read order:
 *   1. Seeded Redis cache (Railway).
 *   2. Direct BIS SDMX CSV fetch via _bis-direct.ts (self-host fallback).
 */

import type {
  ServerContext,
  GetBisCreditRequest,
  GetBisCreditResponse,
} from '../../../../src/generated/server/alsaglobal/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { fetchBisCreditDirect } from './_bis-direct';

const SEED_CACHE_KEY = 'economic:bis:credit:v1';

export async function getBisCredit(
  _ctx: ServerContext,
  _req: GetBisCreditRequest,
): Promise<GetBisCreditResponse> {
  try {
    const cached = await getCachedJson(SEED_CACHE_KEY, true) as GetBisCreditResponse | null;
    if (cached?.entries?.length) return cached;
  } catch {
    // fall through
  }
  try {
    const entries = await fetchBisCreditDirect();
    return { entries };
  } catch (err) {
    console.warn('[getBisCredit] BIS direct fetch failed:', (err as Error).message);
    return { entries: [] };
  }
}
