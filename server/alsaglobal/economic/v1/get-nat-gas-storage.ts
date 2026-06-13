/**
 * RPC: getNatGasStorage -- reads seeded EIA NW2_EPG0_SWO_R48_BCF natural gas storage data.
 * All external EIA API calls happen in seed-economy.mjs on Railway.
 */

import type {
  ServerContext,
  GetNatGasStorageRequest,
  GetNatGasStorageResponse,
} from '../../../../src/generated/server/alsaglobal/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { fetchNatGasStorageDirect } from './_eia-direct';

const SEED_CACHE_KEY = 'economic:nat-gas-storage:v1';

export async function getNatGasStorage(
  _ctx: ServerContext,
  _req: GetNatGasStorageRequest,
): Promise<GetNatGasStorageResponse> {
  // 1. Seeded Redis cache (Railway path)
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetNatGasStorageResponse | null;
    if (result?.weeks?.length) return result;
  } catch {
    // fall through to direct
  }
  // 2. Direct EIA fetch (self-host path — EIA_API_KEY required)
  try {
    return await fetchNatGasStorageDirect();
  } catch (err) {
    console.warn('[getNatGasStorage] EIA direct fetch failed:', (err as Error).message);
    return { weeks: [], latestPeriod: '' };
  }
}
