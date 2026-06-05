/**
 * RPC: getTradeRestrictions -- reads seeded WTO MFN baseline overview data from Railway seed cache.
 * All external WTO API calls happen in seed-supply-chain-trade.mjs on Railway.
 */
import type {
  ServerContext,
  GetTradeRestrictionsRequest,
  GetTradeRestrictionsResponse,
} from '../../../../src/generated/server/alsaglobal/trade/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'trade:restrictions:v1:tariff-overview:50';

type Restriction = GetTradeRestrictionsResponse['restrictions'][number];

const STATIC_RESTRICTIONS: Restriction[] = [
  { reportingCountry: 'US', partnerCountry: 'CN', productCode: 'all', productDescription: 'All goods', measureType: 'Tariff', tariffRate: 145, tradeValueUsd: 440000000000, effectiveDate: '2025-04-09', notes: 'Reciprocal tariffs; baseline 10% + 135% additional on all Chinese imports' },
  { reportingCountry: 'US', partnerCountry: 'all', productCode: 'all', productDescription: 'All goods', measureType: 'Tariff', tariffRate: 10, tradeValueUsd: 3000000000000, effectiveDate: '2025-04-05', notes: 'Universal baseline tariff on all imports' },
  { reportingCountry: 'CN', partnerCountry: 'US', productCode: 'all', productDescription: 'All goods', measureType: 'Tariff', tariffRate: 125, tradeValueUsd: 143000000000, effectiveDate: '2025-04-11', notes: 'Retaliatory tariffs on all US imports' },
  { reportingCountry: 'US', partnerCountry: 'CA', productCode: 'all', productDescription: 'Non-CUSMA goods', measureType: 'Tariff', tariffRate: 25, tradeValueUsd: 420000000000, effectiveDate: '2025-03-04', notes: '25% tariff on Canadian goods not compliant with CUSMA' },
  { reportingCountry: 'US', partnerCountry: 'MX', productCode: 'all', productDescription: 'Non-CUSMA goods', measureType: 'Tariff', tariffRate: 25, tradeValueUsd: 505000000000, effectiveDate: '2025-03-04', notes: '25% tariff on Mexican goods not compliant with CUSMA' },
  { reportingCountry: 'EU', partnerCountry: 'CN', productCode: '870300', productDescription: 'Electric vehicles', measureType: 'Tariff', tariffRate: 45, tradeValueUsd: 8500000000, effectiveDate: '2024-10-30', notes: 'Anti-subsidy duties on Chinese EVs; BYD 17%, SAIC 35.3%, others up to 35.3%' },
  { reportingCountry: 'US', partnerCountry: 'all', productCode: '7208', productDescription: 'Steel products', measureType: 'Tariff', tariffRate: 25, tradeValueUsd: 31000000000, effectiveDate: '2018-03-23', notes: 'Section 232 steel tariff; reinstated globally April 2025' },
  { reportingCountry: 'US', partnerCountry: 'all', productCode: '7601', productDescription: 'Aluminum products', measureType: 'Tariff', tariffRate: 10, tradeValueUsd: 18000000000, effectiveDate: '2018-03-23', notes: 'Section 232 aluminum tariff; raised to 25% April 2025' },
  { reportingCountry: 'IN', partnerCountry: 'US', productCode: 'various', productDescription: 'Various US goods', measureType: 'Tariff', tariffRate: 26, tradeValueUsd: 42000000000, effectiveDate: '2025-04-09', notes: 'Retaliatory tariffs on US agricultural and industrial goods' },
  { reportingCountry: 'US', partnerCountry: 'VN', productCode: 'all', productDescription: 'All goods', measureType: 'Tariff', tariffRate: 46, tradeValueUsd: 134000000000, effectiveDate: '2025-04-09', notes: 'Reciprocal tariff; paused 90 days from April 9 for negotiations' },
];

export async function getTradeRestrictions(
  _ctx: ServerContext,
  req: GetTradeRestrictionsRequest,
): Promise<GetTradeRestrictionsResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetTradeRestrictionsResponse | null;
    const restrictions = result?.restrictions?.length ? result.restrictions : STATIC_RESTRICTIONS;
    const limit = Math.max(1, Math.min(req.limit > 0 ? req.limit : 50, 100));
    return {
      restrictions: restrictions.slice(0, limit),
      fetchedAt: result?.fetchedAt || new Date().toISOString(),
      upstreamUnavailable: !result?.restrictions?.length,
    };
  } catch {
    return { restrictions: STATIC_RESTRICTIONS.slice(0, 50), fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  }
}
