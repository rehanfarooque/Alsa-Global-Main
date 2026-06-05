import type {
  ServerContext,
  ListEarningsCalendarRequest,
  ListEarningsCalendarResponse,
  EarningsEntry,
} from '../../../../src/generated/server/alsaglobal/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

interface FinnhubEarning {
  date: string;
  symbol: string;
  hour: string;
  epsEstimate: number | null;
  epsActual: number | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
}

async function fetchFinnhubEarnings(): Promise<ListEarningsCalendarResponse | null> {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) return null;
  try {
    const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${encodeURIComponent(token)}`;
    const resp = await fetch(url, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const json = await resp.json() as { earningsCalendar?: FinnhubEarning[] };
    const raw = json.earningsCalendar ?? [];
    if (raw.length === 0) return null;
    const earnings: EarningsEntry[] = raw.slice(0, 200).map(e => {
      const hasActuals = e.epsActual !== null;
      const epsDiff = hasActuals && e.epsEstimate ? e.epsActual! - e.epsEstimate : 0;
      return {
        symbol: e.symbol ?? '',
        company: e.symbol ?? '',
        date: e.date ?? '',
        hour: e.hour ?? '',
        epsEstimate: e.epsEstimate ?? 0,
        revenueEstimate: e.revenueEstimate ?? 0,
        epsActual: e.epsActual ?? 0,
        revenueActual: e.revenueActual ?? 0,
        hasActuals,
        surpriseDirection: hasActuals && e.epsEstimate ? (epsDiff > 0 ? 'beat' : 'miss') : '',
      };
    });
    const dates = earnings.map(e => e.date).filter(Boolean).sort();
    return {
      earnings,
      fromDate: dates[0] ?? from,
      toDate: dates[dates.length - 1] ?? to,
      total: earnings.length,
      unavailable: false,
    };
  } catch {
    return null;
  }
}

const SEED_CACHE_KEY = 'market:earnings-calendar:v1';

export async function listEarningsCalendar(
  _ctx: ServerContext,
  _req: ListEarningsCalendarRequest,
): Promise<ListEarningsCalendarResponse> {
  try {
    const cached = await getCachedJson(SEED_CACHE_KEY, true) as { earnings?: EarningsEntry[]; unavailable?: boolean } | null;
    if (!cached?.earnings?.length) {
      const live = await fetchFinnhubEarnings();
      if (live) return live;
      return { earnings: [], fromDate: '', toDate: '', total: 0, unavailable: true };
    }

    const entries: EarningsEntry[] = cached.earnings.map(e => ({
      symbol: e.symbol ?? '',
      company: e.company ?? '',
      date: e.date ?? '',
      hour: e.hour ?? '',
      epsEstimate: e.epsEstimate ?? 0,
      revenueEstimate: e.revenueEstimate ?? 0,
      epsActual: e.epsActual ?? 0,
      revenueActual: e.revenueActual ?? 0,
      hasActuals: e.hasActuals ?? false,
      surpriseDirection: e.surpriseDirection ?? '',
    }));

    const dates = entries.map(e => e.date).filter(Boolean).sort();
    const fromDate = dates[0] ?? '';
    const toDate = dates[dates.length - 1] ?? '';

    return { earnings: entries, fromDate, toDate, total: entries.length, unavailable: false };
  } catch {
    return { earnings: [], fromDate: '', toDate: '', total: 0, unavailable: true };
  }
}
