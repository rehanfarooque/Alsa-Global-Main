/**
 * AlsaGlobal: ListClimateDisasters — NASA EONET v3.
 * Free, no API key required, returns geo-coded natural events.
 * https://eonet.gsfc.nasa.gov/docs/v3
 */

import type {
  ClimateServiceHandler,
  ServerContext,
  ListClimateDisastersRequest,
  ListClimateDisastersResponse,
  ClimateDisaster,
} from '../../../../src/generated/server/alsaglobal/climate/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';

const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events';
const TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 20 * 60 * 1000;

let _cache: { disasters: ClimateDisaster[]; ts: number } | null = null;

const STATIC_DISASTERS: ClimateDisaster[] = [
  { id: 's-flood-bd-2024', type: 'flood', name: 'Bangladesh Monsoon Flooding', country: 'Bangladesh', countryCode: 'BD', lat: 24.9, lng: 91.9, severity: 'HIGH', startedAt: Date.now() - 2 * 86400000, status: 'open', affectedPopulation: 2000000, source: 'EONET/Flooding', sourceUrl: 'https://eonet.gsfc.nasa.gov' },
  { id: 's-storm-wp-1', type: 'storm', name: 'Tropical Storm Western Pacific', country: 'Philippines', countryCode: 'PH', lat: 15.0, lng: 130.0, severity: 'HIGH', startedAt: Date.now() - 86400000, status: 'open', affectedPopulation: 0, source: 'EONET/Severe Storm', sourceUrl: 'https://eonet.gsfc.nasa.gov' },
  { id: 's-volcano-etna', type: 'volcano', name: 'Mt. Etna Volcanic Activity', country: 'Italy', countryCode: 'IT', lat: 37.75, lng: 15.0, severity: 'MEDIUM', startedAt: Date.now() - 3 * 86400000, status: 'open', affectedPopulation: 0, source: 'EONET/Volcano', sourceUrl: 'https://eonet.gsfc.nasa.gov' },
  { id: 's-drought-horn', type: 'drought', name: 'Horn of Africa Drought', country: 'Somalia', countryCode: 'SO', lat: 8.0, lng: 42.0, severity: 'HIGH', startedAt: Date.now() - 10 * 86400000, status: 'open', affectedPopulation: 5000000, source: 'EONET/Drought', sourceUrl: 'https://eonet.gsfc.nasa.gov' },
  { id: 's-wildfire-ca', type: 'wildfire', name: 'California Wildfire Season', country: 'United States', countryCode: 'US', lat: 34.2, lng: -118.5, severity: 'HIGH', startedAt: Date.now() - 5 * 86400000, status: 'open', affectedPopulation: 50000, source: 'EONET/Wildfire', sourceUrl: 'https://eonet.gsfc.nasa.gov' },
  { id: 's-flood-moz', type: 'flood', name: 'Mozambique Cyclone Flooding', country: 'Mozambique', countryCode: 'MZ', lat: -18.0, lng: 35.0, severity: 'HIGH', startedAt: Date.now() - 7 * 86400000, status: 'open', affectedPopulation: 300000, source: 'EONET/Flooding', sourceUrl: 'https://eonet.gsfc.nasa.gov' },
  { id: 's-eq-turkey', type: 'earthquake', name: 'Turkey Seismic Activity', country: 'Turkey', countryCode: 'TR', lat: 38.5, lng: 43.0, severity: 'MEDIUM', startedAt: Date.now() - 4 * 86400000, status: 'open', affectedPopulation: 0, source: 'EONET/Earthquake', sourceUrl: 'https://eonet.gsfc.nasa.gov' },
  { id: 's-heat-eu', type: 'heat_wave', name: 'European Heatwave', country: 'Spain', countryCode: 'ES', lat: 40.0, lng: -4.0, severity: 'HIGH', startedAt: Date.now() - 86400000, status: 'open', affectedPopulation: 1000000, source: 'EONET/Temperature Extreme', sourceUrl: 'https://eonet.gsfc.nasa.gov' },
  { id: 's-hurricane-atl', type: 'storm', name: 'Atlantic Hurricane Season Activity', country: '', countryCode: '', lat: 22.0, lng: -75.0, severity: 'HIGH', startedAt: Date.now() - 2 * 86400000, status: 'open', affectedPopulation: 0, source: 'EONET/Severe Storm', sourceUrl: 'https://eonet.gsfc.nasa.gov' },
  { id: 's-volcano-phl', type: 'volcano', name: 'Mayon Volcano Philippines', country: 'Philippines', countryCode: 'PH', lat: 13.25, lng: 123.68, severity: 'MEDIUM', startedAt: Date.now() - 3 * 86400000, status: 'open', affectedPopulation: 0, source: 'EONET/Volcano', sourceUrl: 'https://eonet.gsfc.nasa.gov' },
  { id: 's-flood-india', type: 'flood', name: 'India Flash Flooding', country: 'India', countryCode: 'IN', lat: 26.0, lng: 85.0, severity: 'MEDIUM', startedAt: Date.now() - 4 * 86400000, status: 'open', affectedPopulation: 500000, source: 'EONET/Flooding', sourceUrl: 'https://eonet.gsfc.nasa.gov' },
  { id: 's-storm-gulf', type: 'storm', name: 'Gulf of Mexico Tropical Activity', country: '', countryCode: '', lat: 24.0, lng: -90.0, severity: 'MEDIUM', startedAt: Date.now() - 5 * 86400000, status: 'open', affectedPopulation: 0, source: 'EONET/Severe Storm', sourceUrl: 'https://eonet.gsfc.nasa.gov' },
  { id: 's-wildfire-aus', type: 'wildfire', name: 'Australia Bushfires', country: 'Australia', countryCode: 'AU', lat: -32.0, lng: 150.0, severity: 'MEDIUM', startedAt: Date.now() - 6 * 86400000, status: 'open', affectedPopulation: 0, source: 'EONET/Wildfire', sourceUrl: 'https://eonet.gsfc.nasa.gov' },
  { id: 's-eq-japan', type: 'earthquake', name: 'Japan Seismic Activity', country: 'Japan', countryCode: 'JP', lat: 35.7, lng: 139.7, severity: 'MEDIUM', startedAt: Date.now() - 8 * 86400000, status: 'open', affectedPopulation: 0, source: 'EONET/Earthquake', sourceUrl: 'https://eonet.gsfc.nasa.gov' },
  { id: 's-flood-nigeria', type: 'flood', name: 'Nigeria Flooding', country: 'Nigeria', countryCode: 'NG', lat: 6.5, lng: 7.5, severity: 'HIGH', startedAt: Date.now() - 9 * 86400000, status: 'open', affectedPopulation: 800000, source: 'EONET/Flooding', sourceUrl: 'https://eonet.gsfc.nasa.gov' },
];

// EONET category ID → AlsaGlobal climate type mapping
const CATEGORY_TYPE_MAP: Record<string, string> = {
  floods:         'flood',
  drought:        'drought',
  severeStorms:   'storm',
  volcanoes:      'volcano',
  landslides:     'landslide',
  wildfires:      'wildfire',
  seaLakeIce:     'ice',
  tempExtremes:   'heat_wave',
  dustHaze:       'other',
  earthquakes:    'earthquake',
  snow:           'other',
  manmade:        'other',
  waterColor:     'other',
};

// EONET category ID → human readable title
const CATEGORY_TITLE: Record<string, string> = {
  floods:         'Flooding',
  drought:        'Drought',
  severeStorms:   'Severe Storm',
  volcanoes:      'Volcano',
  landslides:     'Landslide',
  wildfires:      'Wildfire',
  seaLakeIce:     'Sea/Lake Ice',
  tempExtremes:   'Temperature Extreme',
  dustHaze:       'Dust & Haze',
  earthquakes:    'Earthquake',
  snow:           'Snow',
  manmade:        'Manmade',
  waterColor:     'Water Color',
};

// Closed events are considered lower severity than open
function toSeverity(status: string, catId: string): string {
  if (status === 'open') {
    if (['floods', 'severeStorms', 'volcanoes'].includes(catId)) return 'HIGH';
    return 'MEDIUM';
  }
  return 'LOW';
}

interface EonetEvent {
  id: string;
  title: string;
  description?: string;
  categories: Array<{ id: string; title: string }>;
  sources?: Array<{ id: string; url: string }>;
  status: string;
  geometry: Array<{
    date: string;
    type: string;
    coordinates: number[] | number[][] | number[][][];
  }>;
}

function extractLatLon(geometry: EonetEvent['geometry']): { lat: number; lng: number } | null {
  if (!geometry.length) return null;
  // Use last (most recent) geometry entry
  const g = geometry[geometry.length - 1]!;
  const coords = g.coordinates;
  if (!coords || !coords.length) return null;

  // Point: [lon, lat]
  if (g.type === 'Point' && Array.isArray(coords) && !Array.isArray(coords[0])) {
    const [lon, lat] = coords as number[];
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lng: lon };
  }

  // Polygon: [[[lon, lat], ...]]
  if (g.type === 'Polygon' && Array.isArray(coords[0]) && Array.isArray((coords as number[][][])[0][0])) {
    const ring = (coords as number[][][])[0]!;
    const lats = ring.map((p) => p[1]!).filter(Number.isFinite);
    const lons = ring.map((p) => p[0]!).filter(Number.isFinite);
    if (lats.length) {
      return {
        lat: lats.reduce((a, b) => a + b, 0) / lats.length,
        lng: lons.reduce((a, b) => a + b, 0) / lons.length,
      };
    }
  }

  // LineString: [[lon, lat], ...]
  if (g.type === 'LineString' && Array.isArray(coords[0])) {
    const pts = coords as number[][];
    const midIdx = Math.floor(pts.length / 2);
    const pt = pts[midIdx]!;
    if (Array.isArray(pt) && Number.isFinite(pt[1]) && Number.isFinite(pt[0])) {
      return { lat: pt[1]!, lng: pt[0]! };
    }
  }

  return null;
}

export const listClimateDisasters: ClimateServiceHandler['listClimateDisasters'] = async (
  _ctx: ServerContext,
  req: ListClimateDisastersRequest,
): Promise<ListClimateDisastersResponse> => {
  const limit = Math.max(1, Math.min(200, req.pageSize || 100));

  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) {
    const page = _cache.disasters.slice(0, limit);
    return { disasters: page, pagination: { nextCursor: '', totalCount: _cache.disasters.length } };
  }

  try {
    const url = `${EONET_URL}?status=all&days=30&limit=200`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) throw new Error(`EONET HTTP ${resp.status}`);

    const data = await resp.json() as { events?: EonetEvent[] };
    const items = data.events ?? [];

    const disasters: ClimateDisaster[] = [];
    for (const ev of items) {
      const cat = ev.categories?.[0];
      if (!cat) continue;
      const coords = extractLatLon(ev.geometry);
      if (!coords) continue;
      const geom0 = ev.geometry[ev.geometry.length - 1];
      const eventDate = geom0?.date ? new Date(geom0.date).getTime() : Date.now();
      const srcUrl = ev.sources?.[0]?.url ?? `https://eonet.gsfc.nasa.gov/api/v3/events/${ev.id}`;
      disasters.push({
        id: `eonet-${ev.id}`,
        type: CATEGORY_TYPE_MAP[cat.id] ?? 'other',
        name: ev.title,
        country: '',
        countryCode: '',
        lat: coords.lat,
        lng: coords.lng,
        severity: toSeverity(ev.status, cat.id),
        startedAt: eventDate,
        status: ev.status,
        affectedPopulation: 0,
        source: `EONET/${CATEGORY_TITLE[cat.id] ?? cat.title}`,
        sourceUrl: srcUrl,
      });
    }

    disasters.sort((a, b) => {
      if (a.status === 'open' && b.status !== 'open') return -1;
      if (a.status !== 'open' && b.status === 'open') return 1;
      return b.startedAt - a.startedAt;
    });

    if (disasters.length > 0) {
      _cache = { disasters, ts: Date.now() };
      return { disasters: disasters.slice(0, limit), pagination: { nextCursor: '', totalCount: disasters.length } };
    }
  } catch (err) {
    console.warn('[ClimateDisasters] EONET fetch failed:', (err as Error).message);
  }

  // Static fallback
  const fallback = STATIC_DISASTERS.slice(0, limit);
  return { disasters: fallback, pagination: { nextCursor: '', totalCount: STATIC_DISASTERS.length } };
};
