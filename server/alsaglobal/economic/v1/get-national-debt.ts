/**
 * RPC: getNationalDebt — reads seeded national debt data from Railway seed cache,
 * with a built-in static fallback (IMF WEO 2024 estimates) when Redis is absent.
 * Premium gate removed for self-hosted deployment.
 */

import type {
  ServerContext,
  GetNationalDebtRequest,
  GetNationalDebtResponse,
  NationalDebtEntry,
} from '../../../../src/generated/server/alsaglobal/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'economic:national-debt:v1';

// IMF WEO 2024 estimates. Debt in USD, GDP in USD (approx at market exchange rates).
// perSecondRate = annualDebtGrowth / 31_557_600 (seconds per year).
const STATIC_ENTRIES: NationalDebtEntry[] = (() => {
  const now = new Date().toISOString();
  return [
    { iso3: 'USA', debtUsd: 34_600_000_000_000, gdpUsd: 27_400_000_000_000, debtToGdp: 126.3, annualGrowth: 6.2, perSecondRate: 67_900, perDayRate: 5_866_000_000, baselineTs: now, source: 'IMF WEO 2024' },
    { iso3: 'CHN', debtUsd: 17_200_000_000_000, gdpUsd: 18_600_000_000_000, debtToGdp: 92.5, annualGrowth: 7.8, perSecondRate: 42_500, perDayRate: 3_672_000_000, baselineTs: now, source: 'IMF WEO 2024' },
    { iso3: 'JPN', debtUsd: 12_000_000_000_000, gdpUsd: 4_200_000_000_000, debtToGdp: 255.2, annualGrowth: 3.1, perSecondRate: 11_800, perDayRate: 1_019_000_000, baselineTs: now, source: 'IMF WEO 2024' },
    { iso3: 'GBR', debtUsd: 3_500_000_000_000, gdpUsd: 3_100_000_000_000, debtToGdp: 100.0, annualGrowth: 4.8, perSecondRate: 5_300, perDayRate: 458_000_000, baselineTs: now, source: 'IMF WEO 2024' },
    { iso3: 'FRA', debtUsd: 3_600_000_000_000, gdpUsd: 3_000_000_000_000, debtToGdp: 111.0, annualGrowth: 4.2, perSecondRate: 4_800, perDayRate: 415_000_000, baselineTs: now, source: 'IMF WEO 2024' },
    { iso3: 'ITA', debtUsd: 3_400_000_000_000, gdpUsd: 2_300_000_000_000, debtToGdp: 140.6, annualGrowth: 3.5, perSecondRate: 3_800, perDayRate: 328_000_000, baselineTs: now, source: 'IMF WEO 2024' },
    { iso3: 'DEU', debtUsd: 3_000_000_000_000, gdpUsd: 4_500_000_000_000, debtToGdp: 64.8, annualGrowth: 2.9, perSecondRate: 2_760, perDayRate: 239_000_000, baselineTs: now, source: 'IMF WEO 2024' },
    { iso3: 'CAN', debtUsd: 2_300_000_000_000, gdpUsd: 2_100_000_000_000, debtToGdp: 107.0, annualGrowth: 4.1, perSecondRate: 3_000, perDayRate: 259_000_000, baselineTs: now, source: 'IMF WEO 2024' },
    { iso3: 'IND', debtUsd: 3_300_000_000_000, gdpUsd: 3_700_000_000_000, debtToGdp: 83.4, annualGrowth: 8.2, perSecondRate: 8_600, perDayRate: 743_000_000, baselineTs: now, source: 'IMF WEO 2024' },
    { iso3: 'BRA', debtUsd: 2_000_000_000_000, gdpUsd: 2_000_000_000_000, debtToGdp: 88.6, annualGrowth: 6.5, perSecondRate: 4_100, perDayRate: 354_000_000, baselineTs: now, source: 'IMF WEO 2024' },
    { iso3: 'KOR', debtUsd: 1_100_000_000_000, gdpUsd: 1_700_000_000_000, debtToGdp: 51.9, annualGrowth: 4.3, perSecondRate: 1_500, perDayRate: 130_000_000, baselineTs: now, source: 'IMF WEO 2024' },
    { iso3: 'AUS', debtUsd: 1_000_000_000_000, gdpUsd: 1_700_000_000_000, debtToGdp: 52.4, annualGrowth: 3.8, perSecondRate: 1_200, perDayRate: 104_000_000, baselineTs: now, source: 'IMF WEO 2024' },
    { iso3: 'MEX', debtUsd: 850_000_000_000, gdpUsd: 1_400_000_000_000, debtToGdp: 53.7, annualGrowth: 5.1, perSecondRate: 1_370, perDayRate: 118_000_000, baselineTs: now, source: 'IMF WEO 2024' },
  ];
})();

export async function getNationalDebt(
  _ctx: ServerContext,
  _req: GetNationalDebtRequest,
): Promise<GetNationalDebtResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetNationalDebtResponse | null;
    if (result && !result.unavailable && result.entries && result.entries.length > 0) return result;
  } catch {
    // fall through to static data
  }

  return {
    entries: STATIC_ENTRIES,
    seededAt: new Date().toISOString(),
    unavailable: false,
  };
}
