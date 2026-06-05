import type {
  ServerContext,
  GetEuFsiRequest,
  GetEuFsiResponse,
  EuFsiObservation,
} from '../../../../src/generated/server/alsaglobal/economic/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { CISS_STALE_THRESHOLD_MS } from '../../../../src/shared/ciss-staleness';
import { CHROME_UA } from '../../../_shared/constants';

async function fetchAnfciFromFred(): Promise<GetEuFsiResponse | null> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return null;
  try {
    const startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=ANFCI&observation_start=${startDate}&api_key=${encodeURIComponent(apiKey)}&file_type=json`;
    const resp = await fetch(url, { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const json = await resp.json() as { observations?: Array<{ date: string; value: string }> };
    const raw = (json.observations ?? []).filter(o => o.value !== '.' && o.value !== '');
    if (raw.length === 0) return null;
    const history: EuFsiObservation[] = raw.map(o => ({
      date: o.date,
      // Normalize ANFCI (range ~-1 to +3) to CISS-like scale [0,1]
      value: Math.max(0, Math.min(1, (parseFloat(o.value) + 0.5) / 2)),
    }));
    const last = history[history.length - 1]!;
    const label = last.value < 0.15 ? 'Low' : last.value < 0.35 ? 'Moderate' : last.value < 0.6 ? 'Elevated' : 'High';
    return {
      latestValue: last.value,
      latestDate: last.date,
      label,
      history,
      seededAt: new Date().toISOString(),
      unavailable: false,
      stale: false,
    };
  } catch {
    return null;
  }
}

const SEED_CACHE_KEY = 'economic:fsi-eu:v1';

// `stale` is set when the newest observation is older than the shared CISS
// content-age budget — the ECB series has stopped publishing (issue #3845) —
// so no consumer presents the reading as current.
function isStale(latestDate: string): boolean {
  const ts = Date.parse(latestDate);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts > CISS_STALE_THRESHOLD_MS;
}

function buildFallbackResult(): GetEuFsiResponse {
  return {
    latestValue: 0,
    latestDate: '',
    label: '',
    history: [],
    seededAt: '',
    unavailable: true,
    stale: false,
  };
}

export async function getEuFsi(
  _ctx: ServerContext,
  _req: GetEuFsiRequest,
): Promise<GetEuFsiResponse> {
  try {
    const raw = await getCachedJson(SEED_CACHE_KEY, true) as Record<string, unknown> | null;
    if (!raw || raw.unavailable) {
      const live = await fetchAnfciFromFred();
      if (live) return live;
      return buildFallbackResult();
    }

    const history = (Array.isArray(raw.history) ? raw.history : []) as EuFsiObservation[];
    const latestDate = String(raw.latestDate ?? '');

    return {
      latestValue: Number(raw.latestValue ?? 0),
      latestDate,
      label: String(raw.label ?? ''),
      history,
      seededAt: String(raw.seededAt ?? ''),
      unavailable: false,
      stale: isStale(latestDate),
    };
  } catch {
    return buildFallbackResult();
  }
}
