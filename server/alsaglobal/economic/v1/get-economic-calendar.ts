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

// ─── FRED releases fallback ──────────────────────────────────────────────────
// Finnhub's /calendar/economic endpoint is paid-tier only, so free-key
// self-hosts fall through here. FRED's releases/dates API is free with the
// same key the macro tiles already use, and lists upcoming US statistical
// releases (CPI, Employment Situation, GDP, ...). No estimates/actuals —
// the panel renders those columns as "—".

// Major releases worth showing; everything else in FRED's 300+ catalog is
// niche regional data that would drown the calendar.
const FRED_MAJOR_RELEASES: Record<string, { name: string; impact: string }> = {
  '10':  { name: 'Consumer Price Index', impact: 'high' },
  '50':  { name: 'Employment Situation', impact: 'high' },
  '53':  { name: 'Gross Domestic Product', impact: 'high' },
  '46':  { name: 'Producer Price Index', impact: 'medium' },
  '25':  { name: 'Retail Sales (Advance)', impact: 'high' },
  '20':  { name: 'H.15 Selected Interest Rates', impact: 'low' },
  '82':  { name: 'FOMC Press Release', impact: 'high' },
  '21':  { name: 'Industrial Production', impact: 'medium' },
  '97':  { name: 'Personal Income & Outlays (PCE)', impact: 'high' },
  '180': { name: 'Unemployment Insurance Weekly Claims', impact: 'medium' },
  '352': { name: 'New Residential Sales', impact: 'low' },
  '95':  { name: 'Housing Starts', impact: 'medium' },
  '86':  { name: 'Consumer Confidence', impact: 'medium' },
};

const FRED_CAL_MEM_TTL_MS = 6 * 60 * 60_000;
let _fredCalCache: { result: GetEconomicCalendarResponse; ts: number } | null = null;

async function fetchFredReleasesCalendar(): Promise<GetEconomicCalendarResponse | null> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return null;
  if (_fredCalCache && Date.now() - _fredCalCache.ts < FRED_CAL_MEM_TTL_MS) return _fredCalCache.result;
  try {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const url = `https://api.stlouisfed.org/fred/releases/dates?api_key=${encodeURIComponent(apiKey)}` +
                `&file_type=json&include_release_dates_with_no_data=true` +
                `&realtime_start=${from}&realtime_end=${to}&sort_order=asc&limit=500`;
    const resp = await fetch(url, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const json = await resp.json() as { release_dates?: Array<{ release_id: number; release_name?: string; date: string }> };
    const raw = json.release_dates ?? [];
    const events: EconomicEvent[] = [];
    const seen = new Set<string>();
    for (const r of raw) {
      const meta = FRED_MAJOR_RELEASES[String(r.release_id)];
      if (!meta || !r.date) continue;
      const dedupe = `${r.release_id}:${r.date}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      events.push({
        event: meta.name,
        country: 'US',
        date: r.date,
        impact: meta.impact,
        actual: '',
        estimate: '',
        previous: '',
        unit: '',
      });
    }
    if (events.length === 0) return null;
    events.sort((a, b) => a.date.localeCompare(b.date));
    const result: GetEconomicCalendarResponse = {
      events,
      fromDate: from,
      toDate: to,
      total: events.length,
      unavailable: false,
    };
    _fredCalCache = { result, ts: Date.now() };
    return result;
  } catch {
    return null;
  }
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
  } catch {
    // fall through to live paths
  }
  try {
    const live = await fetchFinnhubEconCalendar();
    if (live) return live;
    const fred = await fetchFredReleasesCalendar();
    if (fred) return fred;
    return buildFallbackResult();
  } catch {
    return buildFallbackResult();
  }
}
