/**
 * Direct BIS REST fetcher used as the no-Redis fallback by the three BIS
 * RPC handlers (policy rates, real-effective exchange rates, credit-to-GDP).
 *
 * Mirrors the logic in scripts/seed-bis-data.mjs but returns parsed values
 * instead of writing to Upstash. In-process memory cache (60-minute TTL)
 * keeps BIS happy when multiple panel reloads hit the same handler.
 *
 * BIS endpoint: https://stats.bis.org/api/v1/data/{dataset}/{key}?format=csv
 * No key, free, no rate limit documented for low-volume use.
 */

import { CHROME_UA } from '../../../_shared/constants';
import type {
  BisPolicyRate,
  BisExchangeRate,
  BisCreditToGdp,
} from '../../../../src/generated/server/alsaglobal/economic/v1/service_server';

const BIS_BASE = 'https://stats.bis.org/api/v1/data';
const BIS_TIMEOUT_MS = 12_000;
const MEM_TTL_MS = 60 * 60_000;

interface BisCountryInfo { name: string; centralBank: string }
const BIS_COUNTRIES: Record<string, BisCountryInfo> = {
  US: { name: 'United States', centralBank: 'Federal Reserve' },
  GB: { name: 'United Kingdom', centralBank: 'Bank of England' },
  JP: { name: 'Japan', centralBank: 'Bank of Japan' },
  XM: { name: 'Euro Area', centralBank: 'ECB' },
  CH: { name: 'Switzerland', centralBank: 'Swiss National Bank' },
  SG: { name: 'Singapore', centralBank: 'MAS' },
  IN: { name: 'India', centralBank: 'Reserve Bank of India' },
  AU: { name: 'Australia', centralBank: 'RBA' },
  CN: { name: 'China', centralBank: "People's Bank of China" },
  CA: { name: 'Canada', centralBank: 'Bank of Canada' },
  KR: { name: 'South Korea', centralBank: 'Bank of Korea' },
  BR: { name: 'Brazil', centralBank: 'Banco Central do Brasil' },
};
const BIS_COUNTRY_KEYS = Object.keys(BIS_COUNTRIES).join('+');

interface MemEntry<T> { value: T; ts: number }
const _mem: { policy?: MemEntry<BisPolicyRate[]>; exchange?: MemEntry<BisExchangeRate[]>; credit?: MemEntry<BisCreditToGdp[]> } = {};

async function fetchCsv(dataset: string, key: string): Promise<string> {
  const sep = key.includes('?') ? '&' : '?';
  const url = `${BIS_BASE}/${dataset}/${key}${sep}format=csv`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv' },
    signal: AbortSignal.timeout(BIS_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`BIS HTTP ${resp.status} for ${dataset}`);
  return resp.text();
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

function parseCsv(csv: string): Array<Record<string, string>> {
  const lines = csv.split('\n');
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]!);
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const vals = parseCsvLine(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = vals[j] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

function parseNum(v: string): number | null {
  if (!v || v === '.' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function groupByCountry(rows: Array<Record<string, string>>): Map<string, Array<{ date: string; value: number }>> {
  const m = new Map<string, Array<{ date: string; value: number }>>();
  for (const row of rows) {
    const cc = row.REF_AREA || row.BORROWERS_CTY || row['Reference area'] || '';
    const date = row.TIME_PERIOD || row['Time period'] || '';
    const val = parseNum(row.OBS_VALUE ?? row['Observation value'] ?? '');
    if (!cc || !date || val === null) continue;
    if (!m.has(cc)) m.set(cc, []);
    m.get(cc)!.push({ date, value: val });
  }
  return m;
}

export async function fetchBisPolicyRatesDirect(): Promise<BisPolicyRate[]> {
  if (_mem.policy && Date.now() - _mem.policy.ts < MEM_TTL_MS) return _mem.policy.value;
  const threeMo = new Date();
  threeMo.setMonth(threeMo.getMonth() - 3);
  const startPeriod = `${threeMo.getFullYear()}-${String(threeMo.getMonth() + 1).padStart(2, '0')}`;
  const csv = await fetchCsv('WS_CBPOL', `M.${BIS_COUNTRY_KEYS}?startPeriod=${startPeriod}&detail=dataonly`);
  const byCountry = groupByCountry(parseCsv(csv));
  const out: BisPolicyRate[] = [];
  for (const [cc, obs] of byCountry) {
    const info = BIS_COUNTRIES[cc];
    if (!info) continue;
    obs.sort((a, b) => a.date.localeCompare(b.date));
    const latest = obs[obs.length - 1];
    const prev = obs.length >= 2 ? obs[obs.length - 2] : undefined;
    if (!latest) continue;
    out.push({
      countryCode: cc,
      countryName: info.name,
      rate: latest.value,
      previousRate: prev?.value ?? latest.value,
      date: latest.date,
      centralBank: info.centralBank,
    });
  }
  _mem.policy = { value: out, ts: Date.now() };
  return out;
}

export async function fetchBisExchangeRatesDirect(): Promise<BisExchangeRate[]> {
  if (_mem.exchange && Date.now() - _mem.exchange.ts < MEM_TTL_MS) return _mem.exchange.value;
  const threeMo = new Date();
  threeMo.setMonth(threeMo.getMonth() - 3);
  const startPeriod = `${threeMo.getFullYear()}-${String(threeMo.getMonth() + 1).padStart(2, '0')}`;
  const csv = await fetchCsv('WS_EER', `M.R.B.${BIS_COUNTRY_KEYS}?startPeriod=${startPeriod}&detail=dataonly`);
  const byCountry = groupByCountry(parseCsv(csv));
  const out: BisExchangeRate[] = [];
  for (const [cc, obs] of byCountry) {
    const info = BIS_COUNTRIES[cc];
    if (!info) continue;
    obs.sort((a, b) => a.date.localeCompare(b.date));
    const latest = obs[obs.length - 1];
    const prev = obs.length >= 2 ? obs[obs.length - 2] : undefined;
    if (!latest) continue;
    const realChange = prev ? Math.round(((latest.value - prev.value) / prev.value) * 1000) / 10 : 0;
    out.push({
      countryCode: cc,
      countryName: info.name,
      realEer: Math.round(latest.value * 100) / 100,
      nominalEer: 0,
      realChange,
      date: latest.date,
    });
  }
  _mem.exchange = { value: out, ts: Date.now() };
  return out;
}

export async function fetchBisCreditDirect(): Promise<BisCreditToGdp[]> {
  if (_mem.credit && Date.now() - _mem.credit.ts < MEM_TTL_MS) return _mem.credit.value;
  const twoYears = new Date();
  twoYears.setFullYear(twoYears.getFullYear() - 2);
  const startPeriod = `${twoYears.getFullYear()}-Q1`;
  const csv = await fetchCsv('WS_TC', `Q.${BIS_COUNTRY_KEYS}.C.A.M.770.A?startPeriod=${startPeriod}&detail=dataonly`);
  const byCountry = groupByCountry(parseCsv(csv));
  const out: BisCreditToGdp[] = [];
  for (const [cc, obs] of byCountry) {
    const info = BIS_COUNTRIES[cc];
    if (!info) continue;
    obs.sort((a, b) => a.date.localeCompare(b.date));
    const latest = obs[obs.length - 1];
    const prev = obs.length >= 2 ? obs[obs.length - 2] : undefined;
    if (!latest) continue;
    out.push({
      countryCode: cc,
      countryName: info.name,
      creditGdpRatio: Math.round(latest.value * 10) / 10,
      previousRatio: prev ? Math.round(prev.value * 10) / 10 : Math.round(latest.value * 10) / 10,
      date: latest.date,
    });
  }
  _mem.credit = { value: out, ts: Date.now() };
  return out;
}
