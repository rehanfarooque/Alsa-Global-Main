/**
 * AlsaGlobal: ListAcledEvents — ACLED primary, GDELT fallback, static zones last resort.
 *
 * ACLED provides precise conflict event data (battles, explosions, violence).
 * Requires ToU acceptance at acleddata.com.
 * Falls back to known active conflict zones when ACLED/GDELT are unavailable.
 */

import type {
  ServerContext,
  ListAcledEventsRequest,
  ListAcledEventsResponse,
  AcledConflictEvent,
} from '../../../../src/generated/server/alsaglobal/conflict/v1/service_server';

import { fetchAcledCached } from '../../../_shared/acled';
import { CHROME_UA } from '../../../_shared/constants';

const GDELT_TIMEOUT_MS = 20_000;

// ─── GDELT fallback ─────────────────────────────────────────────────────────

interface GdeltGeoFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    title?: string;
    url?: string;
    seendate?: string;
    domain?: string;
    sourcecountry?: string;
  };
}

async function fetchGdeltConflicts(country?: string): Promise<AcledConflictEvent[]> {
  const countryFilter = country ? ` sourcecountry:${country.slice(0, 2).toUpperCase()}` : '';
  const query = encodeURIComponent(`battle explosion airstrike attack conflict violence${countryFilter}`);
  const url = `https://api.gdeltproject.org/api/v2/geo/geo?query=${query}&TIMESPAN=2weeks&MAXPOINTS=300&format=JSON`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(GDELT_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('[GDELT] fetch error:', (err as Error).message);
    return [];
  }

  if (!resp.ok) {
    console.warn(`[GDELT] HTTP ${resp.status}`);
    return [];
  }

  let json: { features?: GdeltGeoFeature[] };
  try {
    json = await resp.json();
  } catch {
    return [];
  }

  if (!Array.isArray(json.features)) return [];

  const events: AcledConflictEvent[] = [];
  for (let i = 0; i < json.features.length; i++) {
    const f = json.features[i]!;
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    const [lon, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    const p = f.properties ?? {};
    let occurredAt = Date.now() - i * 3_600_000;
    if (p.seendate) {
      const d = new Date(
        p.seendate
          .replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'),
      );
      if (!isNaN(d.getTime())) occurredAt = d.getTime();
    }

    events.push({
      id: `gdelt-${i}-${lat.toFixed(3)}-${lon.toFixed(3)}`,
      eventType: 'Violence',
      country: p.sourcecountry ?? p.name ?? '',
      location: { latitude: lat, longitude: lon },
      occurredAt,
      fatalities: 0,
      actors: [],
      source: p.domain ?? 'GDELT',
      admin1: p.name ?? '',
    });
  }

  return events;
}

// ─── Static known conflict zones fallback ────────────────────────────────────
// Used when both ACLED and GDELT are unavailable.
// Shows approximate activity areas for ongoing conflicts as of 2025-2026.

interface ConflictZone {
  country: string;
  admin1: string;
  lat: number;
  lon: number;
  spread: number; // radius in degrees for random offset
  count: number;
  eventType: string;
  actor1: string;
}

const ACTIVE_CONFLICT_ZONES: ConflictZone[] = [
  // Russia-Ukraine war
  { country: 'Ukraine', admin1: 'Zaporizhzhia', lat: 47.2, lon: 35.8, spread: 1.5, count: 8, eventType: 'Battles', actor1: 'Ukrainian Military' },
  { country: 'Ukraine', admin1: 'Donetsk', lat: 48.0, lon: 37.5, spread: 1.2, count: 8, eventType: 'Explosions/Remote violence', actor1: 'Ukrainian Military' },
  { country: 'Ukraine', admin1: 'Kherson', lat: 46.6, lon: 32.6, spread: 0.8, count: 4, eventType: 'Battles', actor1: 'Ukrainian Military' },
  { country: 'Ukraine', admin1: 'Kharkiv', lat: 50.0, lon: 36.2, spread: 1.0, count: 5, eventType: 'Explosions/Remote violence', actor1: 'Ukrainian Military' },
  // Israel-Gaza conflict
  { country: 'Palestine', admin1: 'Gaza', lat: 31.4, lon: 34.4, spread: 0.2, count: 8, eventType: 'Explosions/Remote violence', actor1: 'Israeli Army' },
  { country: 'Palestine', admin1: 'West Bank', lat: 32.0, lon: 35.3, spread: 0.5, count: 3, eventType: 'Violence against civilians', actor1: 'Israeli Army' },
  // Sudan civil war
  { country: 'Sudan', admin1: 'Khartoum', lat: 15.5, lon: 32.5, spread: 0.5, count: 5, eventType: 'Battles', actor1: 'Sudanese Armed Forces' },
  { country: 'Sudan', admin1: 'Darfur', lat: 13.5, lon: 24.0, spread: 2.0, count: 5, eventType: 'Violence against civilians', actor1: 'Rapid Support Forces' },
  // Myanmar civil war
  { country: 'Myanmar', admin1: 'Sagaing', lat: 22.5, lon: 95.5, spread: 2.0, count: 5, eventType: 'Battles', actor1: "People's Defence Force" },
  { country: 'Myanmar', admin1: 'Shan', lat: 22.0, lon: 98.0, spread: 1.5, count: 3, eventType: 'Battles', actor1: 'Resistance forces' },
  // Ethiopia conflict
  { country: 'Ethiopia', admin1: 'Amhara', lat: 11.5, lon: 38.0, spread: 2.0, count: 4, eventType: 'Battles', actor1: 'Amhara Fano' },
  { country: 'Ethiopia', admin1: 'Oromia', lat: 8.0, lon: 38.5, spread: 2.5, count: 3, eventType: 'Violence against civilians', actor1: 'OLA/OLF' },
  // Sahel region
  { country: 'Mali', admin1: 'Mopti', lat: 14.5, lon: -4.0, spread: 2.0, count: 4, eventType: 'Battles', actor1: 'JNIM' },
  { country: 'Burkina Faso', admin1: 'Centre-Nord', lat: 13.5, lon: -1.5, spread: 1.5, count: 4, eventType: 'Violence against civilians', actor1: 'JNIM' },
  { country: 'Niger', admin1: 'Tillabery', lat: 14.5, lon: 2.0, spread: 1.5, count: 3, eventType: 'Battles', actor1: 'ISGS' },
  // Somalia
  { country: 'Somalia', admin1: 'Hirshabelle', lat: 4.5, lon: 45.5, spread: 2.0, count: 4, eventType: 'Battles', actor1: 'Al-Shabaab' },
  { country: 'Somalia', admin1: 'Benadir', lat: 2.0, lon: 45.3, spread: 0.5, count: 3, eventType: 'Explosions/Remote violence', actor1: 'Al-Shabaab' },
  // DRC eastern conflict
  { country: 'Democratic Republic of Congo', admin1: 'North Kivu', lat: -1.2, lon: 29.3, spread: 1.0, count: 5, eventType: 'Battles', actor1: 'M23/RDF' },
  { country: 'Democratic Republic of Congo', admin1: 'Ituri', lat: 1.5, lon: 29.5, spread: 1.5, count: 3, eventType: 'Violence against civilians', actor1: 'ADF' },
  // Yemen
  { country: 'Yemen', admin1: 'Hajjah', lat: 15.8, lon: 43.6, spread: 1.5, count: 4, eventType: 'Explosions/Remote violence', actor1: 'Houthi forces' },
  { country: 'Yemen', admin1: "Ma'rib", lat: 15.5, lon: 45.3, spread: 1.0, count: 3, eventType: 'Battles', actor1: 'Houthi forces' },
  // Nigeria
  { country: 'Nigeria', admin1: 'Borno', lat: 12.0, lon: 13.5, spread: 2.0, count: 4, eventType: 'Battles', actor1: 'Boko Haram/ISWAP' },
  // Haiti
  { country: 'Haiti', admin1: "Ouest", lat: 18.5, lon: -72.3, spread: 0.5, count: 4, eventType: 'Violence against civilians', actor1: 'Gang coalition' },
];

function deterministicOffset(seed: number, spread: number): number {
  // Deterministic pseudo-random offset (not truly random, but stable across calls)
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return ((x - Math.floor(x)) * 2 - 1) * spread;
}

function buildStaticFallback(country?: string): AcledConflictEvent[] {
  const now = Date.now();
  const events: AcledConflictEvent[] = [];
  let eventIdx = 0;

  for (const zone of ACTIVE_CONFLICT_ZONES) {
    if (country && !zone.country.toLowerCase().includes(country.toLowerCase())) continue;

    for (let i = 0; i < zone.count; i++) {
      const seed = eventIdx * 1000 + i;
      const lat = zone.lat + deterministicOffset(seed, zone.spread);
      const lon = zone.lon + deterministicOffset(seed + 1, zone.spread);
      // Stagger timestamps over last 14 days
      const occurredAt = now - (seed % (14 * 24 * 3600)) * 1000;

      events.push({
        id: `zone-${eventIdx}-${i}`,
        eventType: zone.eventType,
        country: zone.country,
        location: { latitude: lat, longitude: lon },
        occurredAt,
        fatalities: 0,
        actors: [zone.actor1],
        source: 'Known Conflict Zones',
        admin1: zone.admin1,
      });
    }
    eventIdx++;
  }

  return events;
}

// ─── ACLED primary ───────────────────────────────────────────────────────────

async function fetchAcledConflicts(req: ListAcledEventsRequest): Promise<AcledConflictEvent[]> {
  const now = Date.now();
  const startMs = req.start ?? (now - 30 * 24 * 60 * 60 * 1_000);
  const endMs = req.end ?? now;
  const startDate = new Date(startMs).toISOString().split('T')[0]!;
  const endDate = new Date(endMs).toISOString().split('T')[0]!;

  const rawEvents = await fetchAcledCached({
    eventTypes: 'Battles|Explosions/Remote violence|Violence against civilians',
    startDate,
    endDate,
    country: req.country || undefined,
  });

  return rawEvents
    .filter((e) => {
      const lat = parseFloat(e.latitude || '');
      const lon = parseFloat(e.longitude || '');
      return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    })
    .map((e): AcledConflictEvent => ({
      id: `acled-${e.event_id_cnty}`,
      eventType: e.event_type || '',
      country: e.country || '',
      location: {
        latitude: parseFloat(e.latitude || '0'),
        longitude: parseFloat(e.longitude || '0'),
      },
      occurredAt: new Date(e.event_date || '').getTime(),
      fatalities: parseInt(e.fatalities || '', 10) || 0,
      actors: [e.actor1, e.actor2].filter(Boolean) as string[],
      source: e.source || '',
      admin1: e.admin1 || '',
    }));
}

// ─── Handler ─────────────────────────────────────────────────────────────────

const fallbackCache = new Map<string, { data: ListAcledEventsResponse; ts: number }>();
const FALLBACK_TTL_MS = 15 * 60 * 1_000; // 15 min

export async function listAcledEvents(
  _ctx: ServerContext,
  req: ListAcledEventsRequest,
): Promise<ListAcledEventsResponse> {
  const cacheKey = `${req.country || 'all'}:${req.start || 0}:${req.end || 0}`;

  // Try ACLED first
  try {
    const events = await fetchAcledConflicts(req);
    if (events.length > 0) {
      const result: ListAcledEventsResponse = { events, pagination: undefined };
      fallbackCache.set(cacheKey, { data: result, ts: Date.now() });
      return result;
    }
  } catch (err) {
    console.warn('[ACLED] primary fetch failed:', (err as Error).message);
  }

  // Check in-memory cache (previous good live data)
  const cached = fallbackCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < FALLBACK_TTL_MS) {
    return cached.data;
  }

  // GDELT fallback (may be unavailable from some networks)
  console.info('[ACLED] falling back to GDELT for conflict events');
  try {
    const events = await fetchGdeltConflicts(req.country);
    if (events.length > 0) {
      const result: ListAcledEventsResponse = { events, pagination: undefined };
      fallbackCache.set(cacheKey, { data: result, ts: Date.now() });
      return result;
    }
  } catch (err) {
    console.warn('[GDELT] fallback failed:', (err as Error).message);
  }

  // Last resort: static known conflict zones
  console.info('[Conflict] using static known conflict zones fallback');
  const staticEvents = buildStaticFallback(req.country);
  return { events: staticEvents, pagination: undefined };
}
