/**
 * ListEarthquakes — USGS Earthquake Hazards Program GeoJSON feeds.
 * Free, no auth, updates every minute.
 * Feed: M2.5+ past 30 days (up to ~1500 events).
 */

import type {
  SeismologyServiceHandler,
  ServerContext,
  ListEarthquakesRequest,
  ListEarthquakesResponse,
  Earthquake,
} from '../../../../src/generated/server/alsaglobal/seismology/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';

const USGS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson';
const TIMEOUT_MS = 12_000;

// In-memory cache — USGS feed updates every minute; 3 min TTL is fine.
let _cache: { earthquakes: Earthquake[]; ts: number } | null = null;
const CACHE_TTL_MS = 3 * 60 * 1000;

async function fetchUSGS(): Promise<Earthquake[]> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache.earthquakes;

  const resp = await fetch(USGS_URL, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`USGS HTTP ${resp.status}`);

  const json = await resp.json() as {
    features: Array<{
      id: string;
      properties: {
        mag: number; place: string; time: number;
        url: string; status: string; tsunami: number; sig: number;
      };
      geometry: { coordinates: [number, number, number] };
    }>;
  };

  const earthquakes: Earthquake[] = json.features
    .filter(f => f.properties.mag >= 2.5)
    .map(f => {
      const p = f.properties;
      const [lon, lat, depth] = f.geometry.coordinates;
      return {
        id: f.id,
        place: p.place || '',
        magnitude: p.mag,
        depthKm: depth ?? 0,
        location: { latitude: lat ?? 0, longitude: lon ?? 0 },
        occurredAt: p.time,
        sourceUrl: p.url || '',
        nearTestSite: false,
        concernScore: Math.min(100, Math.round((p.sig || 0) / 10)),
        concernLevel: p.mag >= 7 ? 'HIGH' : p.mag >= 5 ? 'MEDIUM' : 'LOW',
      };
    })
    .sort((a, b) => b.occurredAt - a.occurredAt);

  _cache = { earthquakes, ts: Date.now() };
  return earthquakes;
}

export const listEarthquakes: SeismologyServiceHandler['listEarthquakes'] = async (
  _ctx: ServerContext,
  req: ListEarthquakesRequest,
): Promise<ListEarthquakesResponse> => {
  try {
    const all = await fetchUSGS();
    const pageSize = (req.pageSize && req.pageSize > 0) ? Math.min(req.pageSize, 1000) : 500;
    return { earthquakes: all.slice(0, pageSize), pagination: undefined };
  } catch (err) {
    console.warn('[USGS] fetch failed:', (err as Error).message);
    return { earthquakes: [], pagination: undefined };
  }
};