/**
 * RPC: listUcdpEvents
 *
 * Read order:
 *   1. Seeded Redis cache (Railway path).
 *   2. Direct UCDP Candidate API fetch as no-Redis fallback. UCDP's GED
 *      Candidate dataset is free, no key, returns JSON, and is updated
 *      monthly. We pull the most recent month's events into an in-process
 *      cache (12-hour TTL) so a fresh self-host has Armed Conflict Events
 *      data without needing the Railway seed loop.
 */

import type {
  ServerContext,
  ListUcdpEventsRequest,
  ListUcdpEventsResponse,
  UcdpViolenceEvent,
  UcdpViolenceType,
} from '../../../../src/generated/server/alsaglobal/conflict/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const CACHE_KEY = 'conflict:ucdp-events:v1';
// UCDP rotated to token-required endpoints in mid-2025; the URL pattern is
//   /api/gedevents/{version}    e.g. /api/gedevents/24.1
// Set UCDP_API_VERSION + UCDP_ACCESS_TOKEN to enable the direct fallback.
// Without a token we silently skip the upstream and return whatever cache has.
const UCDP_BASE = `https://ucdpapi.pcr.uu.se/api/gedevents/${process.env.UCDP_API_VERSION ?? '24.1'}`;
const MEM_TTL_MS = 12 * 60 * 60_000;
const UCDP_TIMEOUT_MS = 15_000;
let _memCache: { events: UcdpViolenceEvent[]; ts: number } | null = null;

// UCDP "type_of_violence" codes:
//   1 = state-based armed conflict
//   2 = non-state conflict
//   3 = one-sided violence
function ucdpTypeToEnum(code: number): UcdpViolenceType {
  if (code === 1) return 'UCDP_VIOLENCE_TYPE_STATE_BASED';
  if (code === 2) return 'UCDP_VIOLENCE_TYPE_NON_STATE';
  if (code === 3) return 'UCDP_VIOLENCE_TYPE_ONE_SIDED';
  return 'UCDP_VIOLENCE_TYPE_UNSPECIFIED';
}

interface UcdpRawEvent {
  id: number;
  date_start?: string;
  date_end?: string;
  country?: string;
  side_a?: string;
  side_b?: string;
  best?: number;
  low?: number;
  high?: number;
  type_of_violence?: number;
  latitude?: number;
  longitude?: number;
  source_original?: string;
}

interface UcdpRawPage {
  Result: UcdpRawEvent[];
  TotalCount: number;
  NextPageUrl?: string;
}

async function fetchUcdpDirect(): Promise<UcdpViolenceEvent[]> {
  if (_memCache && Date.now() - _memCache.ts < MEM_TTL_MS) return _memCache.events;

  const token = process.env.UCDP_ACCESS_TOKEN;
  if (!token) {
    // No token configured — caller will see an empty list. ACLED still works
    // for the Armed Conflict layer; UCDP is the deeper monthly-snapshot view.
    return [];
  }

  // 6-month window — recent enough to match what Railway seeds, big enough to
  // populate the panel on a fresh self-host.
  const since = new Date();
  since.setMonth(since.getMonth() - 6);
  const startDate = since.toISOString().slice(0, 10);

  const url = `${UCDP_BASE}?StartDate=${startDate}&pagesize=1000`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': CHROME_UA,
      Accept: 'application/json',
      'x-ucdp-access-token': token,
    },
    signal: AbortSignal.timeout(UCDP_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`UCDP HTTP ${resp.status}`);
  const data = await resp.json() as UcdpRawPage;
  const raw = Array.isArray(data?.Result) ? data.Result : [];

  const events: UcdpViolenceEvent[] = raw.map((r) => {
    const lat = typeof r.latitude === 'number' ? r.latitude : 0;
    const lon = typeof r.longitude === 'number' ? r.longitude : 0;
    return {
      id: String(r.id),
      dateStart: r.date_start ? new Date(r.date_start).getTime() : 0,
      dateEnd: r.date_end ? new Date(r.date_end).getTime() : 0,
      location: (lat || lon) ? { latitude: lat, longitude: lon } : undefined,
      country: r.country ?? '',
      sideA: r.side_a ?? '',
      sideB: r.side_b ?? '',
      deathsBest: r.best ?? 0,
      deathsLow: r.low ?? 0,
      deathsHigh: r.high ?? 0,
      violenceType: ucdpTypeToEnum(r.type_of_violence ?? 0),
      sourceOriginal: r.source_original ?? '',
    };
  });

  _memCache = { events, ts: Date.now() };
  return events;
}

export async function listUcdpEvents(
  _ctx: ServerContext,
  req: ListUcdpEventsRequest,
): Promise<ListUcdpEventsResponse> {
  let events: UcdpViolenceEvent[] = [];
  try {
    const raw = await getCachedJson(CACHE_KEY, true) as { events?: UcdpViolenceEvent[] } | null;
    if (raw?.events?.length) events = raw.events;
  } catch {
    // fall through to direct fetch
  }
  if (events.length === 0) {
    try {
      events = await fetchUcdpDirect();
    } catch (err) {
      console.warn('[listUcdpEvents] direct fetch failed:', (err as Error).message);
      return { events: [], pagination: undefined };
    }
  }
  if (req.country) events = events.filter((e) => e.country === req.country);
  return { events, pagination: undefined };
}
