import type {
  ServerContext,
  ListPositiveGeoEventsRequest,
  ListPositiveGeoEventsResponse,
  PositiveGeoEvent,
} from '../../../../src/generated/server/alsaglobal/positive_events/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const CACHE_KEY = 'positive-events:geo:v1';
const MAX_SOURCE_AGE_MS = 25 * 60 * 60 * 1000;
const FALLBACK_WINDOW_MS = 12 * 60 * 60 * 1000;

// `sourceTs` is the upstream-produced timestamp surfaced in responses;
// `readAt` is when we last successfully loaded this payload from Redis
// and drives the 12 h availability window so a Redis blip on borderline-
// aged data still serves the fallback (issue #3706 review pass).
let fallback: { events: PositiveGeoEvent[]; readAt: number; sourceTs: number } | null = null;

// Test-only reset. The handler keeps `fallback` in module-local state for
// cross-request availability; tests need to exercise the empty-path
// branch deterministically without inheriting state from a previous test.
export function __resetFallbackForTest(): void {
  fallback = null;
}

export async function listPositiveGeoEvents(
  _ctx: ServerContext,
  _req: ListPositiveGeoEventsRequest,
): Promise<ListPositiveGeoEventsResponse> {
  try {
    const raw = await getCachedJson(CACHE_KEY, true) as { events?: PositiveGeoEvent[]; fetchedAt?: number } | null;
    if (raw?.events?.length && (!raw.fetchedAt || (Date.now() - raw.fetchedAt) < MAX_SOURCE_AGE_MS)) {
      const sourceTs = raw.fetchedAt ?? Date.now();
      fallback = { events: raw.events, readAt: Date.now(), sourceTs };
      return { events: raw.events, fetchedAt: sourceTs, stale: false };
    }
  } catch { /* fall through */ }

  if (fallback && (Date.now() - fallback.readAt) < FALLBACK_WINDOW_MS) {
    // Serving a previously-cached payload because the upstream source is
    // unavailable or has aged out. `fetchedAt` reports the original
    // upstream timestamp so the client can render an accurate "data
    // produced N hours ago" warning; the FALLBACK_WINDOW_MS check uses
    // `readAt` so we keep serving for the full 12 h after the last
    // successful read regardless of how aged the source was at that
    // moment. See issue #3706.
    return { events: fallback.events, fetchedAt: fallback.sourceTs, stale: true };
  }

  // Static positive events fallback
  const staticEvents: PositiveGeoEvent[] = [
    { latitude: 0.3, longitude: 32.6, name: 'Uganda tree-planting initiative', category: 'environment', count: 250000, timestamp: Date.now() - 2 * 86400000 },
    { latitude: 51.5, longitude: -0.1, name: 'London clean energy milestone', category: 'climate', count: 1, timestamp: Date.now() - 86400000 },
    { latitude: -33.9, longitude: 18.4, name: 'Cape Town water recovery', category: 'environment', count: 1, timestamp: Date.now() - 3 * 86400000 },
    { latitude: 1.3, longitude: 103.8, name: 'Singapore green building certification', category: 'sustainability', count: 120, timestamp: Date.now() - 4 * 86400000 },
    { latitude: 35.7, longitude: 139.7, name: 'Tokyo carbon neutrality pledge', category: 'climate', count: 1, timestamp: Date.now() - 5 * 86400000 },
    { latitude: -23.5, longitude: -46.6, name: 'São Paulo vaccination drive', category: 'health', count: 800000, timestamp: Date.now() - 2 * 86400000 },
    { latitude: 40.7, longitude: -74.0, name: 'New York renewable energy record', category: 'energy', count: 1, timestamp: Date.now() - 86400000 },
    { latitude: 48.9, longitude: 2.3, name: 'Paris biodiversity treaty signed', category: 'environment', count: 30, timestamp: Date.now() - 6 * 86400000 },
    { latitude: 52.5, longitude: 13.4, name: 'Berlin solar expansion', category: 'energy', count: 50000, timestamp: Date.now() - 3 * 86400000 },
    { latitude: 37.6, longitude: 126.9, name: 'Seoul AI climate initiative', category: 'technology', count: 1, timestamp: Date.now() - 7 * 86400000 },
    { latitude: 19.1, longitude: 72.9, name: 'Mumbai clean water access', category: 'health', count: 500000, timestamp: Date.now() - 4 * 86400000 },
    { latitude: -15.8, longitude: -47.9, name: 'Brazil Amazon reforestation', category: 'environment', count: 1000000, timestamp: Date.now() - 5 * 86400000 },
    { latitude: 9.1, longitude: 7.4, name: 'Nigeria solar rural electrification', category: 'energy', count: 10000, timestamp: Date.now() - 8 * 86400000 },
    { latitude: 30.0, longitude: 31.2, name: 'Egypt solar megaproject online', category: 'energy', count: 1, timestamp: Date.now() - 3 * 86400000 },
    { latitude: 28.6, longitude: 77.2, name: 'India 100GW solar milestone', category: 'energy', count: 1, timestamp: Date.now() - 2 * 86400000 },
  ];
  return { events: staticEvents, fetchedAt: Date.now() - 86400000, stale: true };
}
