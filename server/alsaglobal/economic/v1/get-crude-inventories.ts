/**
 * RPC: getCrudeInventories -- reads seeded EIA WCRSTUS1 crude oil inventory data.
 * All external EIA API calls happen in seed-economy.mjs on Railway.
 */

import type {
  ServerContext,
  GetCrudeInventoriesRequest,
  GetCrudeInventoriesResponse,
} from '../../../../src/generated/server/alsaglobal/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { fetchCrudeInventoriesDirect } from './_eia-direct';

const SEED_CACHE_KEY = 'economic:crude-inventories:v1';

export async function getCrudeInventories(
  _ctx: ServerContext,
  _req: GetCrudeInventoriesRequest,
): Promise<GetCrudeInventoriesResponse> {
  // 1. Seeded Redis cache (Railway path)
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetCrudeInventoriesResponse | null;
    if (result?.weeks?.length) return result;
  } catch {
    // fall through to direct
  }
  // 2. Direct EIA fetch (self-host path — EIA_API_KEY required)
  try {
    return await fetchCrudeInventoriesDirect();
  } catch (err) {
    console.warn('[getCrudeInventories] EIA direct fetch failed:', (err as Error).message);
    return { weeks: [], latestPeriod: '' };
  }
}
