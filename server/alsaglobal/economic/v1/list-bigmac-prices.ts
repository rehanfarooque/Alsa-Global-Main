/**
 * RPC: listBigMacPrices
 *
 * Read order:
 *   1. Seeded Redis cache (Railway uses EXA-scraped current prices).
 *   2. Direct fallback from The Economist's open Big Mac Index dataset on
 *      GitHub. Theirs is updated twice a year (January and July) and gives
 *      the canonical USD-adjusted price per country — the same anchor the
 *      panel labels as "Real Big Mac Index". Cached in-process for 24h.
 *
 * Source: https://github.com/TheEconomist/big-mac-data/blob/master/output-data/big-mac-full-index.csv
 */

import type {
  ServerContext,
  ListBigMacPricesRequest,
  ListBigMacPricesResponse,
  BigMacCountryPrice,
} from '../../../../src/generated/server/alsaglobal/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const SEED_CACHE_KEY = 'economic:bigmac:v1';
const ECONOMIST_CSV = 'https://raw.githubusercontent.com/TheEconomist/big-mac-data/master/output-data/big-mac-full-index.csv';
const BIGMAC_TIMEOUT_MS = 12_000;
const MEM_TTL_MS = 24 * 60 * 60_000;
let _memCache: { result: ListBigMacPricesResponse; ts: number } | null = null;

const EMPTY: ListBigMacPricesResponse = {
  countries: [],
  fetchedAt: '',
  cheapestCountry: '',
  mostExpensiveCountry: '',
  wowAvgPct: 0,
  wowAvailable: false,
  prevFetchedAt: '',
};

// ISO-3 → ISO-2. The Economist CSV uses ISO-3 codes; the panel renders flags
// from ISO-2 so we map the countries the dashboard cares about.
const ISO3_TO_ISO2: Record<string, string> = {
  ARG: 'AR', AUS: 'AU', AUT: 'AT', BEL: 'BE', BHR: 'BH', BRA: 'BR',
  CAN: 'CA', CHE: 'CH', CHL: 'CL', CHN: 'CN', COL: 'CO', CRI: 'CR',
  CZE: 'CZ', DEU: 'DE', DNK: 'DK', EGY: 'EG', ESP: 'ES', EST: 'EE',
  EUZ: 'EU', FIN: 'FI', FRA: 'FR', GBR: 'GB', GRC: 'GR', GTM: 'GT',
  HKG: 'HK', HND: 'HN', HRV: 'HR', HUN: 'HU', IDN: 'ID', IND: 'IN',
  IRL: 'IE', ISR: 'IL', ITA: 'IT', JOR: 'JO', JPN: 'JP', KOR: 'KR',
  KWT: 'KW', LBN: 'LB', LKA: 'LK', LTU: 'LT', LUX: 'LU', LVA: 'LV',
  MEX: 'MX', MYS: 'MY', NIC: 'NI', NLD: 'NL', NOR: 'NO', NZL: 'NZ',
  OMN: 'OM', PAK: 'PK', PER: 'PE', PHL: 'PH', POL: 'PL', PRT: 'PT',
  QAT: 'QA', ROU: 'RO', RUS: 'RU', SAU: 'SA', SGP: 'SG', SVK: 'SK',
  SVN: 'SI', SWE: 'SE', THA: 'TH', TUR: 'TR', TWN: 'TW', UKR: 'UA',
  URY: 'UY', USA: 'US', VEN: 'VE', VNM: 'VN', ZAF: 'ZA',
};

function flagFor(iso2: string): string {
  if (iso2.length !== 2) return '';
  const A = 0x1F1E6 - 65;
  return String.fromCodePoint(iso2.charCodeAt(0) + A, iso2.charCodeAt(1) + A);
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

async function fetchBigMacDirect(): Promise<ListBigMacPricesResponse> {
  if (_memCache && Date.now() - _memCache.ts < MEM_TTL_MS) return _memCache.result;

  const resp = await fetch(ECONOMIST_CSV, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv' },
    signal: AbortSignal.timeout(BIGMAC_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`BigMac CSV HTTP ${resp.status}`);
  const csv = await resp.text();
  const lines = csv.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
  if (lines.length < 2) throw new Error('BigMac CSV: no rows');

  const headers = parseCsvLine(lines[0]!);
  const idx = (name: string) => headers.findIndex((h) => h.toLowerCase() === name);
  const iDate = idx('date');
  const iIso = idx('iso_a3');
  const iName = idx('name');
  const iCcy = idx('currency_code');
  const iLocal = idx('local_price');
  const iUsd = idx('dollar_price');
  const iFx = idx('dollar_ex');
  if (iDate < 0 || iIso < 0 || iLocal < 0 || iUsd < 0) {
    throw new Error('BigMac CSV missing expected columns');
  }

  // Find the most recent publication date and grab all rows for it.
  let latestDate = '';
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]!);
    const d = cols[iDate] ?? '';
    if (d > latestDate) latestDate = d;
  }
  if (!latestDate) throw new Error('BigMac CSV: no dates');

  const countries: BigMacCountryPrice[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]!);
    if ((cols[iDate] ?? '') !== latestDate) continue;
    const iso3 = (cols[iIso] ?? '').toUpperCase();
    const iso2 = ISO3_TO_ISO2[iso3] ?? '';
    const local = parseFloat(cols[iLocal] ?? '');
    const usd = parseFloat(cols[iUsd] ?? '');
    const fx = parseFloat(cols[iFx] ?? '');
    if (!Number.isFinite(local) || !Number.isFinite(usd)) continue;
    countries.push({
      code: iso2 || iso3,
      name: cols[iName] ?? iso3,
      currency: (cols[iCcy] ?? '').toUpperCase(),
      flag: flagFor(iso2),
      localPrice: +local.toFixed(2),
      usdPrice: +usd.toFixed(2),
      fxRate: Number.isFinite(fx) ? +fx.toFixed(4) : 0,
      sourceSite: 'economist.com',
      available: true,
      wowPct: 0,
    });
  }
  if (countries.length === 0) throw new Error('BigMac CSV: no usable rows');

  countries.sort((a, b) => a.usdPrice - b.usdPrice);
  const cheapest = countries[0]!;
  const expensive = countries[countries.length - 1]!;

  const result: ListBigMacPricesResponse = {
    countries,
    fetchedAt: latestDate,
    cheapestCountry: cheapest.code,
    mostExpensiveCountry: expensive.code,
    wowAvgPct: 0,
    wowAvailable: false,
    prevFetchedAt: '',
  };
  _memCache = { result, ts: Date.now() };
  return result;
}

export async function listBigMacPrices(
  _ctx: ServerContext,
  _req: ListBigMacPricesRequest,
): Promise<ListBigMacPricesResponse> {
  try {
    const cached = await getCachedJson(SEED_CACHE_KEY, true) as ListBigMacPricesResponse | null;
    if (cached?.countries?.length) return cached;
  } catch {
    // fall through
  }
  try {
    return await fetchBigMacDirect();
  } catch (err) {
    console.warn('[listBigMacPrices] direct fetch failed:', (err as Error).message);
    return EMPTY;
  }
}
