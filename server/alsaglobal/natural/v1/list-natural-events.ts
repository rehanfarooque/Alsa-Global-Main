/**
 * ListNaturalEvents — NASA EONET v3 + curated static fallback.
 */

import type {
  NaturalServiceHandler,
  ServerContext,
  ListNaturalEventsRequest,
  ListNaturalEventsResponse,
  NaturalEvent,
} from '../../../../src/generated/server/alsaglobal/natural/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const SEED_CACHE_KEY = 'natural:events:v1';
const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?limit=50&days=30&status=open';
const TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 15 * 60 * 1000;

let _cache: { events: NaturalEvent[]; ts: number } | null = null;

interface EonetGeometry {
  magnitudeValue?: number;
  magnitudeUnit?: string;
  date: string;
  type: string;
  coordinates: number[] | number[][];
}

interface EonetEvent {
  id: string;
  title: string;
  description?: string | null;
  link: string;
  closed?: string | null;
  categories: Array<{ id: string; title: string }>;
  sources: Array<{ id: string; url: string }>;
  geometry: EonetGeometry[];
}

function extractCoords(geo: EonetGeometry): [number, number] | null {
  const c = geo.coordinates;
  if (!c || c.length === 0) return null;
  if (Array.isArray(c[0])) {
    const last = (c as number[][])[c.length - 1];
    if (last && last.length >= 2) return [last[1], last[0]];
    return null;
  }
  const flat = c as number[];
  if (flat.length >= 2) return [flat[1], flat[0]];
  return null;
}

function mapEonetEvent(e: EonetEvent): NaturalEvent | null {
  if (!e.geometry || e.geometry.length === 0) return null;
  const geo = e.geometry[e.geometry.length - 1];
  const coords = extractCoords(geo);
  if (!coords) return null;
  const [lat, lon] = coords;
  const cat = e.categories?.[0];
  return {
    id: e.id,
    title: e.title,
    description: e.description || '',
    category: cat?.id || 'other',
    categoryTitle: cat?.title || 'Other',
    lat,
    lon,
    date: geo.date ? new Date(geo.date).getTime() : Date.now(),
    magnitude: geo.magnitudeValue ?? 0,
    magnitudeUnit: geo.magnitudeUnit ?? '',
    sourceUrl: e.link || e.sources?.[0]?.url || '',
    sourceName: 'NASA EONET',
    closed: !!e.closed,
  };
}

async function fetchEonet(): Promise<NaturalEvent[]> {
  const resp = await fetch(EONET_URL, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`EONET HTTP ${resp.status}`);
  const data = await resp.json() as { events: EonetEvent[] };
  return (data.events || []).map(mapEonetEvent).filter((e): e is NaturalEvent => e !== null);
}

const STATIC_EVENTS: NaturalEvent[] = [
  { id: 'static-flood-bd', title: 'Bangladesh Monsoon Flooding', description: 'Severe flooding across Sylhet and northern Bangladesh affecting millions.', category: 'floods', categoryTitle: 'Floods', lat: 24.9, lon: 91.9, date: Date.now() - 2 * 86400000, magnitude: 0, magnitudeUnit: '', sourceUrl: 'https://eonet.gsfc.nasa.gov', sourceName: 'Static', closed: false },
  { id: 'static-storm-wp-1', title: 'Tropical Storm Western Pacific', description: 'Active tropical system in the Western Pacific approaching Philippines.', category: 'severeStorms', categoryTitle: 'Severe Storms', lat: 15.0, lon: 130.0, date: Date.now() - 86400000, magnitude: 55, magnitudeUnit: 'kts', sourceUrl: 'https://eonet.gsfc.nasa.gov', sourceName: 'Static', closed: false },
  { id: 'static-volcano-etna', title: 'Mt. Etna Volcanic Activity', description: 'Ongoing eruptive activity at Mt. Etna, Sicily with lava flows and ash.', category: 'volcanoes', categoryTitle: 'Volcanoes', lat: 37.75, lon: 15.0, date: Date.now() - 3 * 86400000, magnitude: 0, magnitudeUnit: '', sourceUrl: 'https://eonet.gsfc.nasa.gov', sourceName: 'Static', closed: false },
  { id: 'static-drought-horn', title: 'Horn of Africa Drought', description: 'Severe drought conditions across Horn of Africa affecting food security.', category: 'drought', categoryTitle: 'Drought', lat: 8.0, lon: 42.0, date: Date.now() - 10 * 86400000, magnitude: 0, magnitudeUnit: '', sourceUrl: 'https://eonet.gsfc.nasa.gov', sourceName: 'Static', closed: false },
  { id: 'static-wildfire-ca', title: 'California Wildfire Season', description: 'Active wildfires across Southern California driven by dry and windy conditions.', category: 'wildfires', categoryTitle: 'Wildfires', lat: 34.2, lon: -118.5, date: Date.now() - 5 * 86400000, magnitude: 0, magnitudeUnit: '', sourceUrl: 'https://eonet.gsfc.nasa.gov', sourceName: 'Static', closed: false },
  { id: 'static-flood-mozamb', title: 'Mozambique Cyclone Flooding', description: 'Flood damage and displacement in central Mozambique following tropical storm.', category: 'floods', categoryTitle: 'Floods', lat: -18.0, lon: 35.0, date: Date.now() - 7 * 86400000, magnitude: 0, magnitudeUnit: '', sourceUrl: 'https://eonet.gsfc.nasa.gov', sourceName: 'Static', closed: false },
  { id: 'static-eq-turkey', title: 'Turkey Seismic Activity', description: 'Ongoing aftershocks in eastern Turkey following recent earthquake sequence.', category: 'earthquakes', categoryTitle: 'Earthquakes', lat: 38.5, lon: 43.0, date: Date.now() - 4 * 86400000, magnitude: 4.8, magnitudeUnit: 'Richter', sourceUrl: 'https://eonet.gsfc.nasa.gov', sourceName: 'Static', closed: false },
  { id: 'static-heatwave-eu', title: 'European Heatwave', description: 'Extreme heat conditions across Spain, Italy, and Greece with temperatures above 40°C.', category: 'severeStorms', categoryTitle: 'Severe Storms', lat: 40.0, lon: 15.0, date: Date.now() - 86400000, magnitude: 43, magnitudeUnit: '°C', sourceUrl: 'https://eonet.gsfc.nasa.gov', sourceName: 'Static', closed: false },
  { id: 'static-hurricane-atl', title: 'Atlantic Hurricane Season Activity', description: 'Multiple tropical systems active in the Atlantic during peak hurricane season.', category: 'severeStorms', categoryTitle: 'Severe Storms', lat: 22.0, lon: -75.0, date: Date.now() - 2 * 86400000, magnitude: 75, magnitudeUnit: 'kts', sourceUrl: 'https://eonet.gsfc.nasa.gov', sourceName: 'Static', closed: false },
  { id: 'static-volcano-phl', title: 'Mayon Volcano Activity Philippines', description: 'Mayon volcano in Albay province showing elevated activity with lava fountaining.', category: 'volcanoes', categoryTitle: 'Volcanoes', lat: 13.25, lon: 123.68, date: Date.now() - 3 * 86400000, magnitude: 0, magnitudeUnit: '', sourceUrl: 'https://eonet.gsfc.nasa.gov', sourceName: 'Static', closed: false },
];

export const listNaturalEvents: NaturalServiceHandler['listNaturalEvents'] = async (
  _ctx: ServerContext,
  _req: ListNaturalEventsRequest,
): Promise<ListNaturalEventsResponse> => {
  // Return cached if fresh
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) {
    return { events: _cache.events };
  }

  // Try Redis seed first
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as { events: NaturalEvent[] } | null;
    if (result?.events?.length) {
      _cache = { events: result.events, ts: Date.now() };
      return { events: result.events };
    }
  } catch { /* fall through */ }

  // Try NASA EONET live
  try {
    const live = await fetchEonet();
    if (live.length > 0) {
      const seenIds = new Set(live.map(e => e.id));
      const merged = [...live, ...STATIC_EVENTS.filter(s => !seenIds.has(s.id))];
      _cache = { events: merged, ts: Date.now() };
      return { events: merged };
    }
  } catch (err) {
    console.warn('[EONET] fetch failed:', (err as Error).message);
  }

  // Static fallback
  _cache = { events: STATIC_EVENTS, ts: Date.now() };
  return { events: STATIC_EVENTS };
};
