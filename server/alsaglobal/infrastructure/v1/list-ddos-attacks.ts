import type {
  ServerContext,
  ListInternetDdosAttacksRequest,
  ListInternetDdosAttacksResponse,
  DdosAttackSummaryEntry,
  DdosLocationHit,
} from '../../../../src/generated/server/alsaglobal/infrastructure/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const SEED_CACHE_KEY = 'cf:radar:ddos:v1';
const CF_BASE = 'https://api.cloudflare.com/client/v4/radar/attacks';
const TIMEOUT_MS = 12_000;

let _cache: { data: ListInternetDdosAttacksResponse; ts: number } | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000;

async function fetchCloudflareRadar(): Promise<ListInternetDdosAttacksResponse | null> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return null;
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': CHROME_UA, Accept: 'application/json' };
  try {
    const [protocolRes, vectorRes, topLocRes] = await Promise.all([
      fetch(`${CF_BASE}/layer3/summary/protocol?dateRange=7d`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }),
      fetch(`${CF_BASE}/layer3/summary/vector?dateRange=7d`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }),
      fetch(`${CF_BASE}/layer3/top/locations/target?dateRange=7d&limit=10`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }),
    ]);

    if (!protocolRes.ok || !vectorRes.ok) return null;

    const [protocolData, vectorData, topLocData] = await Promise.all([
      protocolRes.json() as Promise<{ result: { summary_0: Record<string, string>; meta?: { dateRange?: Array<{ startTime?: string; endTime?: string }> } } }>,
      vectorRes.json() as Promise<{ result: { summary_0: Record<string, string> } }>,
      topLocRes.ok ? topLocRes.json() as Promise<{ result: { top_0?: Array<{ clientCountryAlpha2?: string; clientCountryName?: string; value?: string }> } }> : Promise.resolve({ result: { top_0: [] } }),
    ]);

    const protocol: DdosAttackSummaryEntry[] = Object.entries(protocolData.result?.summary_0 ?? {}).map(([label, pct]) => ({
      label, percentage: parseFloat(pct),
    })).sort((a, b) => b.percentage - a.percentage);

    const vector: DdosAttackSummaryEntry[] = Object.entries(vectorData.result?.summary_0 ?? {}).map(([label, pct]) => ({
      label, percentage: parseFloat(pct),
    })).sort((a, b) => b.percentage - a.percentage);

    const topLocs = topLocData.result?.top_0 ?? [];
    const topTargetLocations: DdosLocationHit[] = topLocs.map((loc) => ({
      countryCode: loc.clientCountryAlpha2 ?? '',
      countryName: loc.clientCountryName ?? '',
      value: parseFloat(loc.value ?? '0'),
    }));

    const meta = protocolData.result?.meta?.dateRange?.[0];
    return {
      protocol,
      vector,
      dateRangeStart: meta?.startTime ?? '',
      dateRangeEnd: meta?.endTime ?? '',
      topTargetLocations,
    };
  } catch {
    return null;
  }
}

export async function listInternetDdosAttacks(
  _ctx: ServerContext,
  _req: ListInternetDdosAttacksRequest,
): Promise<ListInternetDdosAttacksResponse> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache.data;

  try {
    const seed = await getCachedJson(SEED_CACHE_KEY, true) as ListInternetDdosAttacksResponse | null;
    if (seed?.protocol?.length) {
      _cache = { data: seed, ts: Date.now() };
      return seed;
    }
  } catch { /* fall through */ }

  const live = await fetchCloudflareRadar();
  if (live?.protocol?.length) {
    _cache = { data: live, ts: Date.now() };
    return live;
  }

  const empty: ListInternetDdosAttacksResponse = { protocol: [], vector: [], dateRangeStart: '', dateRangeEnd: '', topTargetLocations: [] };
  return empty;
}
