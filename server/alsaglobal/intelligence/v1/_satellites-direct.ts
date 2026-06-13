/**
 * Direct CelesTrak TLE fetcher — no-Redis fallback for the satellites panel.
 * CelesTrak is free, no key. Mirrors the relay's seedSatelliteTLEs logic:
 * pulls the 'military' + 'resource' GP groups, filters to recon/SAR/optical
 * birds by name, classifies type + country, and caches in-process for 6h
 * (TLEs drift slowly; the panel recomputes orbital position client-side).
 */

import { CHROME_UA } from '../../../_shared/constants';

const CELESTRAK_GROUPS = ['military', 'resource'];
const CELESTRAK_TIMEOUT_MS = 15_000;
const MEM_TTL_MS = 6 * 60 * 60_000;

export interface DirectSatellite {
  noradId: string;
  name: string;
  line1: string;
  line2: string;
  type: string;
  country: string;
}

const NAME_FILTERS: RegExp[] = [
  /^YAOGAN/i, /^GAOFEN/i, /^JILIN/i,
  /^COSMOS 2[4-9]\d{2}/i,
  /^COSMO-SKYMED/i, /^TERRASAR/i, /^PAZ$/i, /^SAR-LUPE/i,
  /^WORLDVIEW/i, /^SKYSAT/i, /^PLEIADES/i, /^KOMPSAT/i,
  /^SAPPHIRE/i, /^PRAETORIAN/i,
  /^SENTINEL/i,
  /^CARTOSAT/i,
  /^GOKTURK/i, /^RASAT/i,
  /^USA[ -]?\d/i,
  /^ZIYUAN/i,
];

function classify(name: string): { type: string; country: string } {
  const n = name.toUpperCase();
  let type = 'military';
  if (/COSMO-SKYMED|TERRASAR|PAZ|SAR-LUPE|YAOGAN/i.test(n)) type = 'sar';
  else if (/WORLDVIEW|SKYSAT|PLEIADES|KOMPSAT|GAOFEN|JILIN|CARTOSAT|ZIYUAN/i.test(n)) type = 'optical';
  else if (/SAPPHIRE|PRAETORIAN|USA|GOKTURK/i.test(n)) type = 'military';

  let country = 'OTHER';
  if (/^YAOGAN|^GAOFEN|^JILIN|^ZIYUAN/i.test(n)) country = 'CN';
  else if (/^COSMOS/i.test(n)) country = 'RU';
  else if (/^WORLDVIEW|^SAPPHIRE|^PRAETORIAN|^USA|^SKYSAT/i.test(n)) country = 'US';
  else if (/^SENTINEL|^COSMO-SKYMED|^TERRASAR|^SAR-LUPE|^PAZ|^PLEIADES/i.test(n)) country = 'EU';
  else if (/^KOMPSAT/i.test(n)) country = 'KR';
  else if (/^CARTOSAT/i.test(n)) country = 'IN';
  else if (/^GOKTURK|^RASAT/i.test(n)) country = 'TR';

  return { type, country };
}

let _memCache: { sats: DirectSatellite[]; ts: number } | null = null;

export async function fetchSatellitesDirect(): Promise<DirectSatellite[]> {
  if (_memCache && Date.now() - _memCache.ts < MEM_TTL_MS) return _memCache.sats;

  const byNorad = new Map<string, { noradId: string; name: string; line1: string; line2: string }>();

  for (const group of CELESTRAK_GROUPS) {
    let text: string;
    try {
      const resp = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`, {
        headers: { 'User-Agent': CHROME_UA, Accept: 'text/plain' },
        signal: AbortSignal.timeout(CELESTRAK_TIMEOUT_MS),
      });
      if (!resp.ok) continue;
      text = await resp.text();
    } catch {
      continue;
    }

    const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
    for (let i = 0; i < lines.length - 2; i++) {
      const l1 = lines[i + 1]!;
      const l2 = lines[i + 2]!;
      if (!l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;
      if (l1.length !== 69 || l2.length !== 69) continue;
      const name = lines[i]!.trim();
      const noradId = l1.substring(2, 7).trim();
      if (!byNorad.has(noradId)) {
        byNorad.set(noradId, { noradId, name, line1: l1, line2: l2 });
      }
      i += 2;
    }
  }

  const sats: DirectSatellite[] = [];
  for (const sat of byNorad.values()) {
    if (!NAME_FILTERS.some((rx) => rx.test(sat.name))) continue;
    const { type, country } = classify(sat.name);
    sats.push({ ...sat, type, country });
  }

  if (sats.length > 0) _memCache = { sats, ts: Date.now() };
  return sats;
}
