import type {
  ServerContext,
  GetEconomicCalendarRequest,
  GetEconomicCalendarResponse,
  EconomicEvent,
} from '../../../../src/generated/server/alsaglobal/economic/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

interface FinnhubEconEvent {
  time: string;
  event: string;
  country: string;
  impact: string;
  actual: number | null;
  estimate: number | null;
  prev: number | null;
  unit: string;
}

async function fetchFinnhubEconCalendar(): Promise<GetEconomicCalendarResponse | null> {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) return null;
  try {
    const from = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const url = `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${encodeURIComponent(token)}`;
    const resp = await fetch(url, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const json = await resp.json() as { economicCalendar?: FinnhubEconEvent[] };
    const raw = json.economicCalendar ?? [];
    if (raw.length === 0) return null;
    const events: EconomicEvent[] = raw.slice(0, 300).map(e => ({
      event: e.event ?? '',
      country: e.country ?? '',
      date: (e.time ?? '').split(' ')[0] ?? '',
      impact: e.impact ?? 'low',
      actual: e.actual !== null && e.actual !== undefined ? String(e.actual) : '',
      estimate: e.estimate !== null && e.estimate !== undefined ? String(e.estimate) : '',
      previous: e.prev !== null && e.prev !== undefined ? String(e.prev) : '',
      unit: e.unit ?? '',
    }));
    return { events, fromDate: from, toDate: to, total: events.length, unavailable: false };
  } catch {
    return null;
  }
}

const SEED_CACHE_KEY = 'economic:econ-calendar:v1';

function buildFallbackResult(): GetEconomicCalendarResponse {
  return {
    events: [],
    fromDate: '',
    toDate: '',
    total: 0,
    unavailable: true,
  };
}

export async function getEconomicCalendar(
  _ctx: ServerContext,
  _req: GetEconomicCalendarRequest,
): Promise<GetEconomicCalendarResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetEconomicCalendarResponse | null;
    if (result && !result.unavailable && Array.isArray(result.events) && result.events.length > 0) {
      return {
        events: result.events as EconomicEvent[],
        fromDate: result.fromDate ?? '',
        toDate: result.toDate ?? '',
        total: result.total ?? result.events.length,
        unavailable: false,
      };
    }
    const live = await fetchFinnhubEconCalendar();
    if (live) return live;
    return buildFallbackResult();
  } catch {
    return buildFallbackResult();
  }
}
