/**
 * Direct EIA v2 API fetchers, used as the no-Redis fallback by the energy
 * inventory handlers (crude stocks, natural-gas storage). Mirrors the logic
 * in scripts/seed-economy.mjs but returns parsed values instead of writing to
 * Upstash. In-process memory cache (30-minute TTL) — EIA publishes weekly so
 * this is conservative.
 *
 * Requires EIA_API_KEY (free, https://www.eia.gov/opendata/register.php).
 */

import { CHROME_UA } from '../../../_shared/constants';

const EIA_TIMEOUT_MS = 12_000;
const MEM_TTL_MS = 30 * 60_000;

export interface CrudeWeek { period: string; stocksMb: number; weeklyChangeMb?: number }
export interface NatGasWeek { period: string; storBcf: number; weeklyChangeBcf?: number }

interface EiaRow { period?: string; value?: string | number | null }
interface EiaResponse { response?: { data?: EiaRow[] } }

const _mem: {
  crude?: { weeks: CrudeWeek[]; latestPeriod: string; ts: number };
  natgas?: { weeks: NatGasWeek[]; latestPeriod: string; ts: number };
} = {};

async function eiaFetch(url: string): Promise<EiaResponse> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(EIA_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`EIA HTTP ${resp.status}`);
  return resp.json() as Promise<EiaResponse>;
}

function isIsoDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export async function fetchCrudeInventoriesDirect(): Promise<{ weeks: CrudeWeek[]; latestPeriod: string }> {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) throw new Error('Missing EIA_API_KEY');
  if (_mem.crude && Date.now() - _mem.crude.ts < MEM_TTL_MS) {
    return { weeks: _mem.crude.weeks, latestPeriod: _mem.crude.latestPeriod };
  }

  const params = new URLSearchParams({
    api_key: apiKey,
    'facets[series][]': 'WCRSTUS1',
    frequency: 'weekly',
    'data[]': 'value',
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: '9',
  });
  const data = await eiaFetch(`https://api.eia.gov/v2/petroleum/stoc/wstk/data/?${params}`);
  const rows = data.response?.data ?? [];
  if (rows.length === 0) throw new Error('EIA WCRSTUS1: no rows');

  const weeks: CrudeWeek[] = [];
  for (let i = 0; i < Math.min(rows.length, 9); i++) {
    const row = rows[i]!;
    const stocksMb = row.value != null ? parseFloat(String(row.value)) : NaN;
    if (!Number.isFinite(stocksMb)) continue;
    const period = isIsoDate(row.period) ? row.period : '';
    const older = rows[i + 1];
    let weeklyChangeMb: number | undefined;
    if (older?.value != null) {
      const o = parseFloat(String(older.value));
      if (Number.isFinite(o)) weeklyChangeMb = +(stocksMb - o).toFixed(3);
    }
    weeks.push({ period, stocksMb: +stocksMb.toFixed(3), weeklyChangeMb });
    if (weeks.length === 8) break;
  }
  if (weeks.length === 0) throw new Error('EIA WCRSTUS1: no valid rows');
  const latestPeriod = weeks[0]?.period ?? '';
  _mem.crude = { weeks, latestPeriod, ts: Date.now() };
  return { weeks, latestPeriod };
}

export async function fetchNatGasStorageDirect(): Promise<{ weeks: NatGasWeek[]; latestPeriod: string }> {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) throw new Error('Missing EIA_API_KEY');
  if (_mem.natgas && Date.now() - _mem.natgas.ts < MEM_TTL_MS) {
    return { weeks: _mem.natgas.weeks, latestPeriod: _mem.natgas.latestPeriod };
  }

  const params = new URLSearchParams({
    api_key: apiKey,
    'facets[series][]': 'NW2_EPG0_SWO_R48_BCF',
    frequency: 'weekly',
    'data[]': 'value',
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: '9',
  });
  const data = await eiaFetch(`https://api.eia.gov/v2/natural-gas/stor/wkly/data/?${params}`);
  const rows = data.response?.data ?? [];
  if (rows.length === 0) throw new Error('EIA NW2: no rows');

  const weeks: NatGasWeek[] = [];
  for (let i = 0; i < Math.min(rows.length, 9); i++) {
    const row = rows[i]!;
    const storBcf = row.value != null ? parseFloat(String(row.value)) : NaN;
    if (!Number.isFinite(storBcf)) continue;
    const period = isIsoDate(row.period) ? row.period : '';
    const older = rows[i + 1];
    let weeklyChangeBcf: number | undefined;
    if (older?.value != null) {
      const o = parseFloat(String(older.value));
      if (Number.isFinite(o)) weeklyChangeBcf = +(storBcf - o).toFixed(3);
    }
    weeks.push({ period, storBcf: +storBcf.toFixed(3), weeklyChangeBcf });
    if (weeks.length === 8) break;
  }
  if (weeks.length === 0) throw new Error('EIA NW2: no valid rows');
  const latestPeriod = weeks[0]?.period ?? '';
  _mem.natgas = { weeks, latestPeriod, ts: Date.now() };
  return { weeks, latestPeriod };
}
