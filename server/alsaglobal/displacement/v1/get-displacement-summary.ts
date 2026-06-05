/**
 * GetDisplacementSummary RPC -- paginates through the UNHCR Population API,
 * aggregates raw records into per-country displacement metrics from origin and
 * asylum perspectives, computes refugee flow corridors, and attaches geographic
 * coordinates from hardcoded centroids.
 */

import type {
  ServerContext,
  GetDisplacementSummaryRequest,
  GetDisplacementSummaryResponse,
  GeoCoordinates,
} from '../../../../src/generated/server/alsaglobal/displacement/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'displacement:summary:v1';
const REDIS_CACHE_TTL = 43200; // 12 hr — annual UNHCR data, very slow-moving
const SEED_FRESHNESS_MS = 7 * 60 * 60 * 1000; // 7 hours — seed runs every 6hr

// ---------- Country centroids (ISO3 -> [lat, lon]) ----------

const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  AFG: [33.9, 67.7], SYR: [35.0, 38.0], UKR: [48.4, 31.2], SDN: [15.5, 32.5],
  SSD: [6.9, 31.3], SOM: [5.2, 46.2], COD: [-4.0, 21.8], MMR: [19.8, 96.7],
  YEM: [15.6, 48.5], ETH: [9.1, 40.5], VEN: [6.4, -66.6], IRQ: [33.2, 43.7],
  COL: [4.6, -74.1], NGA: [9.1, 7.5], PSE: [31.9, 35.2], TUR: [39.9, 32.9],
  DEU: [51.2, 10.4], PAK: [30.4, 69.3], UGA: [1.4, 32.3], BGD: [23.7, 90.4],
  KEN: [0.0, 38.0], TCD: [15.5, 19.0], JOR: [31.0, 36.0], LBN: [33.9, 35.5],
  EGY: [26.8, 30.8], IRN: [32.4, 53.7], TZA: [-6.4, 34.9], RWA: [-1.9, 29.9],
  CMR: [7.4, 12.4], MLI: [17.6, -4.0], BFA: [12.3, -1.6], NER: [17.6, 8.1],
  CAF: [6.6, 20.9], MOZ: [-18.7, 35.5], USA: [37.1, -95.7], FRA: [46.2, 2.2],
  GBR: [55.4, -3.4], IND: [20.6, 79.0], CHN: [35.9, 104.2], RUS: [61.5, 105.3],
};

// ---------- Internal UNHCR API types ----------

interface UnhcrRawItem {
  coo_iso?: string;
  coo_name?: string;
  coa_iso?: string;
  coa_name?: string;
  refugees?: number;
  asylum_seekers?: number;
  idps?: number;
  stateless?: number;
}

// ---------- Helpers ----------

/** Paginate through all UNHCR Population API pages for a given year. */
async function fetchUnhcrYearItems(year: number): Promise<UnhcrRawItem[] | null> {
  const limit = 10000;
  const maxPageGuard = 25;
  const items: UnhcrRawItem[] = [];

  for (let page = 1; page <= maxPageGuard; page++) {
    const response = await fetch(
      `https://api.unhcr.org/population/v1/population/?year=${year}&limit=${limit}&page=${page}&coo_all=true&coa_all=true`,
      { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(10_000) },
    );

    if (!response.ok) return null;

    const data = await response.json();
    const pageItems: UnhcrRawItem[] = Array.isArray(data.items) ? data.items : [];
    if (pageItems.length === 0) break;
    items.push(...pageItems);

    const maxPages = Number(data.maxPages);
    if (Number.isFinite(maxPages) && maxPages > 0) {
      if (page >= maxPages) break;
      continue;
    }

    if (pageItems.length < limit) break;
  }

  return items;
}

/** Look up centroid coordinates for an ISO3 country code. */
function getCoordinates(code: string): GeoCoordinates | undefined {
  const centroid = COUNTRY_CENTROIDS[code];
  if (!centroid) return undefined;
  return { latitude: centroid[0], longitude: centroid[1] };
}

// ---------- Aggregation types ----------

interface OriginAgg {
  name: string;
  refugees: number;
  asylumSeekers: number;
  idps: number;
  stateless: number;
}

interface AsylumAgg {
  name: string;
  refugees: number;
  asylumSeekers: number;
}

interface FlowAgg {
  originCode: string;
  originName: string;
  asylumCode: string;
  asylumName: string;
  refugees: number;
}

interface MergedCountry {
  code: string;
  name: string;
  refugees: number;
  asylumSeekers: number;
  idps: number;
  stateless: number;
  totalDisplaced: number;
  hostRefugees: number;
  hostAsylumSeekers: number;
  hostTotal: number;
}

// ---------- Seed-first helpers ----------

async function trySeededData(req: GetDisplacementSummaryRequest): Promise<GetDisplacementSummaryResponse | null> {
  try {
    const year = req.year > 0 ? req.year : new Date().getFullYear();
    const seedKey = `${REDIS_CACHE_KEY}:${year}`;
    const [seedData, seedMeta] = await Promise.all([
      getCachedJson(seedKey, true) as Promise<GetDisplacementSummaryResponse | null>,
      getCachedJson('seed-meta:displacement:summary', true) as Promise<{ fetchedAt?: number } | null>,
    ]);

    if (!seedData?.summary) return null;

    const fetchedAt = seedMeta?.fetchedAt ?? 0;
    const isFresh = Date.now() - fetchedAt < SEED_FRESHNESS_MS;

    if (isFresh || !process.env.SEED_FALLBACK_DISPLACEMENT) {
      const summary = { ...seedData.summary };
      if (req.countryLimit > 0) summary.countries = summary.countries.slice(0, req.countryLimit);
      const flowLimit = req.flowLimit > 0 ? req.flowLimit : 50;
      summary.topFlows = summary.topFlows.slice(0, flowLimit);
      return { summary };
    }

    return null;
  } catch {
    return null;
  }
}

// UNHCR 2024 curated static data (source: unhcr.org/global-trends, mid-2024 figures)
const STATIC_SUMMARY: GetDisplacementSummaryResponse = {
  summary: {
    year: 2024,
    globalTotals: { refugees: 43400000, asylumSeekers: 7000000, idps: 68300000, stateless: 5600000, total: 117500000 },
    countries: [
      { code: 'SYR', name: 'Syria', refugees: 6600000, asylumSeekers: 400000, idps: 7200000, stateless: 160000, totalDisplaced: 14360000, hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0, location: { latitude: 35.0, longitude: 38.0 } },
      { code: 'AFG', name: 'Afghanistan', refugees: 5700000, asylumSeekers: 500000, idps: 4600000, stateless: 67000, totalDisplaced: 10867000, hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0, location: { latitude: 33.9, longitude: 67.7 } },
      { code: 'VEN', name: 'Venezuela', refugees: 6400000, asylumSeekers: 1300000, idps: 0, stateless: 0, totalDisplaced: 7700000, hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0, location: { latitude: 6.4, longitude: -66.6 } },
      { code: 'SDN', name: 'Sudan', refugees: 1200000, asylumSeekers: 150000, idps: 7700000, stateless: 0, totalDisplaced: 9050000, hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0, location: { latitude: 15.5, longitude: 32.5 } },
      { code: 'UKR', name: 'Ukraine', refugees: 6500000, asylumSeekers: 450000, idps: 3700000, stateless: 36000, totalDisplaced: 10686000, hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0, location: { latitude: 48.4, longitude: 31.2 } },
      { code: 'COD', name: 'DR Congo', refugees: 900000, asylumSeekers: 30000, idps: 6900000, stateless: 0, totalDisplaced: 7830000, hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0, location: { latitude: -4.0, longitude: 21.8 } },
      { code: 'ETH', name: 'Ethiopia', refugees: 200000, asylumSeekers: 10000, idps: 4000000, stateless: 0, totalDisplaced: 4210000, hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0, location: { latitude: 9.1, longitude: 40.5 } },
      { code: 'SSD', name: 'South Sudan', refugees: 2100000, asylumSeekers: 200000, idps: 2100000, stateless: 0, totalDisplaced: 4400000, hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0, location: { latitude: 6.9, longitude: 31.3 } },
      { code: 'SOM', name: 'Somalia', refugees: 800000, asylumSeekers: 50000, idps: 3500000, stateless: 10000, totalDisplaced: 4360000, hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0, location: { latitude: 5.2, longitude: 46.2 } },
      { code: 'MMR', name: 'Myanmar', refugees: 1300000, asylumSeekers: 200000, idps: 1900000, stateless: 600000, totalDisplaced: 4000000, hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0, location: { latitude: 19.8, longitude: 96.7 } },
      { code: 'PSE', name: 'Palestine (Gaza)', refugees: 6000000, asylumSeekers: 100000, idps: 2000000, stateless: 0, totalDisplaced: 8100000, hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0, location: { latitude: 31.9, longitude: 35.2 } },
      { code: 'YEM', name: 'Yemen', refugees: 100000, asylumSeekers: 10000, idps: 4300000, stateless: 0, totalDisplaced: 4410000, hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0, location: { latitude: 15.6, longitude: 48.5 } },
      { code: 'IRQ', name: 'Iraq', refugees: 200000, asylumSeekers: 20000, idps: 1200000, stateless: 47000, totalDisplaced: 1467000, hostRefugees: 280000, hostAsylumSeekers: 15000, hostTotal: 295000, location: { latitude: 33.2, longitude: 43.7 } },
      { code: 'NGA', name: 'Nigeria', refugees: 90000, asylumSeekers: 10000, idps: 3100000, stateless: 0, totalDisplaced: 3200000, hostRefugees: 80000, hostAsylumSeekers: 20000, hostTotal: 100000, location: { latitude: 9.1, longitude: 7.5 } },
      { code: 'TUR', name: 'Turkey', refugees: 0, asylumSeekers: 0, idps: 0, stateless: 0, totalDisplaced: 0, hostRefugees: 3700000, hostAsylumSeekers: 500000, hostTotal: 4200000, location: { latitude: 39.9, longitude: 32.9 } },
      { code: 'PAK', name: 'Pakistan', refugees: 0, asylumSeekers: 0, idps: 0, stateless: 0, totalDisplaced: 0, hostRefugees: 1700000, hostAsylumSeekers: 4000000, hostTotal: 5700000, location: { latitude: 30.4, longitude: 69.3 } },
      { code: 'DEU', name: 'Germany', refugees: 0, asylumSeekers: 0, idps: 0, stateless: 0, totalDisplaced: 0, hostRefugees: 2100000, hostAsylumSeekers: 400000, hostTotal: 2500000, location: { latitude: 51.2, longitude: 10.4 } },
      { code: 'IRN', name: 'Iran', refugees: 0, asylumSeekers: 0, idps: 0, stateless: 0, totalDisplaced: 0, hostRefugees: 3400000, hostAsylumSeekers: 200000, hostTotal: 3600000, location: { latitude: 32.4, longitude: 53.7 } },
      { code: 'UGA', name: 'Uganda', refugees: 0, asylumSeekers: 0, idps: 0, stateless: 0, totalDisplaced: 0, hostRefugees: 1600000, hostAsylumSeekers: 50000, hostTotal: 1650000, location: { latitude: 1.4, longitude: 32.3 } },
      { code: 'COL', name: 'Colombia', refugees: 0, asylumSeekers: 0, idps: 6800000, stateless: 0, totalDisplaced: 6800000, hostRefugees: 2900000, hostAsylumSeekers: 1400000, hostTotal: 4300000, location: { latitude: 4.6, longitude: -74.1 } },
    ],
    topFlows: [
      { originCode: 'SYR', originName: 'Syria', asylumCode: 'TUR', asylumName: 'Turkey', refugees: 3600000, originLocation: { latitude: 35.0, longitude: 38.0 }, asylumLocation: { latitude: 39.9, longitude: 32.9 } },
      { originCode: 'AFG', originName: 'Afghanistan', asylumCode: 'PAK', asylumName: 'Pakistan', refugees: 1800000, originLocation: { latitude: 33.9, longitude: 67.7 }, asylumLocation: { latitude: 30.4, longitude: 69.3 } },
      { originCode: 'UKR', originName: 'Ukraine', asylumCode: 'DEU', asylumName: 'Germany', refugees: 1100000, originLocation: { latitude: 48.4, longitude: 31.2 }, asylumLocation: { latitude: 51.2, longitude: 10.4 } },
      { originCode: 'SYR', originName: 'Syria', asylumCode: 'DEU', asylumName: 'Germany', refugees: 900000, originLocation: { latitude: 35.0, longitude: 38.0 }, asylumLocation: { latitude: 51.2, longitude: 10.4 } },
      { originCode: 'AFG', originName: 'Afghanistan', asylumCode: 'IRN', asylumName: 'Iran', refugees: 2000000, originLocation: { latitude: 33.9, longitude: 67.7 }, asylumLocation: { latitude: 32.4, longitude: 53.7 } },
      { originCode: 'VEN', originName: 'Venezuela', asylumCode: 'COL', asylumName: 'Colombia', refugees: 2900000, originLocation: { latitude: 6.4, longitude: -66.6 }, asylumLocation: { latitude: 4.6, longitude: -74.1 } },
      { originCode: 'SSD', originName: 'South Sudan', asylumCode: 'UGA', asylumName: 'Uganda', refugees: 1100000, originLocation: { latitude: 6.9, longitude: 31.3 }, asylumLocation: { latitude: 1.4, longitude: 32.3 } },
      { originCode: 'SOM', originName: 'Somalia', asylumCode: 'ETH', asylumName: 'Ethiopia', refugees: 420000, originLocation: { latitude: 5.2, longitude: 46.2 }, asylumLocation: { latitude: 9.1, longitude: 40.5 } },
      { originCode: 'MMR', originName: 'Myanmar', asylumCode: 'BGD', asylumName: 'Bangladesh', refugees: 950000, originLocation: { latitude: 19.8, longitude: 96.7 }, asylumLocation: { latitude: 23.7, longitude: 90.4 } },
      { originCode: 'SDN', originName: 'Sudan', asylumCode: 'TCD', asylumName: 'Chad', refugees: 700000, originLocation: { latitude: 15.5, longitude: 32.5 }, asylumLocation: { latitude: 15.5, longitude: 19.0 } },
    ],
  },
};

// ---------- RPC handler ----------

export async function getDisplacementSummary(
  _ctx: ServerContext,
  req: GetDisplacementSummaryRequest,
): Promise<GetDisplacementSummaryResponse> {
  const emptyResponse: GetDisplacementSummaryResponse = {
    summary: {
      year: req.year > 0 ? req.year : new Date().getFullYear(),
      globalTotals: { refugees: 0, asylumSeekers: 0, idps: 0, stateless: 0, total: 0 },
      countries: [],
      topFlows: [],
    },
  };

  try {
    const seeded = await trySeededData(req);
    if (seeded) return seeded;

    // Redis shared cache (keyed by year)
    const year = req.year > 0 ? req.year : new Date().getFullYear();
    const cacheKey = `${REDIS_CACHE_KEY}:${year}`;

    const result = await cachedFetchJson<GetDisplacementSummaryResponse>(cacheKey, REDIS_CACHE_TTL, async () => {
      // 1. Determine year with fallback
      const currentYear = new Date().getFullYear();
      const requestYear = req.year > 0 ? req.year : 0;
      let rawItems: UnhcrRawItem[] = [];
      let dataYearUsed = currentYear;

      if (requestYear > 0) {
        const items = await fetchUnhcrYearItems(requestYear);
        if (items && items.length > 0) {
          rawItems = items;
          dataYearUsed = requestYear;
        }
      } else {
        for (let y = currentYear; y >= currentYear - 2; y--) {
          const items = await fetchUnhcrYearItems(y);
          if (!items) continue;
          if (items.length > 0) {
            rawItems = items;
            dataYearUsed = y;
            break;
          }
        }
      }

      if (rawItems.length === 0) return null;

      // 2. Aggregate by origin and asylum
      const byOrigin: Record<string, OriginAgg> = {};
      const byAsylum: Record<string, AsylumAgg> = {};
      const flowMap: Record<string, FlowAgg> = {};
      let totalRefugees = 0;
      let totalAsylumSeekers = 0;
      let totalIdps = 0;
      let totalStateless = 0;

      for (const item of rawItems) {
        const originCode = item.coo_iso || '';
        const asylumCode = item.coa_iso || '';
        const refugees = Number(item.refugees) || 0;
        const asylumSeekers = Number(item.asylum_seekers) || 0;
        const idps = Number(item.idps) || 0;
        const stateless = Number(item.stateless) || 0;

        totalRefugees += refugees;
        totalAsylumSeekers += asylumSeekers;
        totalIdps += idps;
        totalStateless += stateless;

        if (originCode) {
          if (!byOrigin[originCode]) {
            byOrigin[originCode] = {
              name: item.coo_name || originCode,
              refugees: 0, asylumSeekers: 0, idps: 0, stateless: 0,
            };
          }
          byOrigin[originCode].refugees += refugees;
          byOrigin[originCode].asylumSeekers += asylumSeekers;
          byOrigin[originCode].idps += idps;
          byOrigin[originCode].stateless += stateless;
        }

        if (asylumCode) {
          if (!byAsylum[asylumCode]) {
            byAsylum[asylumCode] = {
              name: item.coa_name || asylumCode,
              refugees: 0, asylumSeekers: 0,
            };
          }
          byAsylum[asylumCode].refugees += refugees;
          byAsylum[asylumCode].asylumSeekers += asylumSeekers;
        }

        if (originCode && asylumCode && refugees > 0) {
          const flowKey = `${originCode}->${asylumCode}`;
          if (!flowMap[flowKey]) {
            flowMap[flowKey] = {
              originCode,
              originName: item.coo_name || originCode,
              asylumCode,
              asylumName: item.coa_name || asylumCode,
              refugees: 0,
            };
          }
          flowMap[flowKey].refugees += refugees;
        }
      }

      // 3. Merge into unified country records
      const countries: Record<string, MergedCountry> = {};

      for (const [code, data] of Object.entries(byOrigin)) {
        countries[code] = {
          code,
          name: data.name,
          refugees: data.refugees,
          asylumSeekers: data.asylumSeekers,
          idps: data.idps,
          stateless: data.stateless,
          totalDisplaced: data.refugees + data.asylumSeekers + data.idps + data.stateless,
          hostRefugees: 0,
          hostAsylumSeekers: 0,
          hostTotal: 0,
        };
      }

      for (const [code, data] of Object.entries(byAsylum)) {
        const hostRefugees = data.refugees;
        const hostAsylumSeekers = data.asylumSeekers;
        const hostTotal = hostRefugees + hostAsylumSeekers;

        if (!countries[code]) {
          countries[code] = {
            code,
            name: data.name,
            refugees: 0,
            asylumSeekers: 0,
            idps: 0,
            stateless: 0,
            totalDisplaced: 0,
            hostRefugees,
            hostAsylumSeekers,
            hostTotal,
          };
        } else {
          countries[code].hostRefugees = hostRefugees;
          countries[code].hostAsylumSeekers = hostAsylumSeekers;
          countries[code].hostTotal = hostTotal;
        }
      }

      // 4. Sort countries by max(totalDisplaced, hostTotal) descending
      const sortedCountries = Object.values(countries).sort((a, b) => {
        const aSize = Math.max(a.totalDisplaced, a.hostTotal);
        const bSize = Math.max(b.totalDisplaced, b.hostTotal);
        return bSize - aSize;
      });

      // 5. Build proto-shaped countries with GeoCoordinates (cache ALL — limits applied post-cache)
      const protoCountries = sortedCountries.map((d) => ({
        code: d.code,
        name: d.name,
        refugees: d.refugees,
        asylumSeekers: d.asylumSeekers,
        idps: d.idps,
        stateless: d.stateless,
        totalDisplaced: d.totalDisplaced,
        hostRefugees: d.hostRefugees,
        hostAsylumSeekers: d.hostAsylumSeekers,
        hostTotal: d.hostTotal,
        location: getCoordinates(d.code),
      }));

      // 6. Build flows sorted by refugees descending (cache ALL — limits applied post-cache)
      const protoFlows = Object.values(flowMap)
        .sort((a, b) => b.refugees - a.refugees)
        .map((f) => ({
          originCode: f.originCode,
          originName: f.originName,
          asylumCode: f.asylumCode,
          asylumName: f.asylumName,
          refugees: f.refugees,
          originLocation: getCoordinates(f.originCode),
          asylumLocation: getCoordinates(f.asylumCode),
        }));

      return {
        summary: {
          year: dataYearUsed,
          globalTotals: {
            refugees: totalRefugees,
            asylumSeekers: totalAsylumSeekers,
            idps: totalIdps,
            stateless: totalStateless,
            total: totalRefugees + totalAsylumSeekers + totalIdps + totalStateless,
          },
          countries: protoCountries,
          topFlows: protoFlows,
        },
      };
    });

    if (result?.summary) {
      const summary = { ...result.summary };
      if (req.countryLimit > 0) {
        summary.countries = summary.countries.slice(0, req.countryLimit);
      }
      const flowLimit = req.flowLimit > 0 ? req.flowLimit : 50;
      summary.topFlows = summary.topFlows.slice(0, flowLimit);
      return { summary };
    }
    if (result?.summary) return result;
    // Static UNHCR 2024 fallback when UNHCR API unavailable
    return applyLimits(STATIC_SUMMARY, req);
  } catch {
    return applyLimits(STATIC_SUMMARY, req);
  }
}

function applyLimits(resp: GetDisplacementSummaryResponse, req: GetDisplacementSummaryRequest): GetDisplacementSummaryResponse {
  if (!resp.summary) return resp;
  const summary = { ...resp.summary };
  if (req.countryLimit > 0) summary.countries = summary.countries.slice(0, req.countryLimit);
  const flowLimit = req.flowLimit > 0 ? req.flowLimit : 50;
  summary.topFlows = summary.topFlows.slice(0, flowLimit);
  return { summary };
}
