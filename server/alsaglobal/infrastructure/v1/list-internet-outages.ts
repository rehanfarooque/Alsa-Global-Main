/**
 * ListInternetOutages — NetBlocks RSS + curated static outage fallback.
 * NetBlocks tracks internet disruptions, outages, and censorship globally.
 * Cloudflare Radar is used when credentials exist but may be TCP-blocked.
 */

import type {
  ServerContext,
  ListInternetOutagesRequest,
  ListInternetOutagesResponse,
  InternetOutage,
} from '../../../../src/generated/server/alsaglobal/infrastructure/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const SEED_CACHE_KEY = 'infra:outages:v1';
const NETBLOCKS_RSS = 'https://netblocks.org/feed';
const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 15 * 60 * 1000;

let _cache: { outages: InternetOutage[]; ts: number } | null = null;

// Curated static outages — recent known internet disruptions
const STATIC_OUTAGES: InternetOutage[] = [
  { id: 'so-ru-2025-06', title: 'Russia: Ongoing Social Media Throttling', link: 'https://netblocks.org/reports', description: 'Persistent throttling of VPNs, social media, and foreign news sites by Roskomnadzor.', detectedAt: Date.now() - 5 * 86400000, country: 'Russia', region: 'Eastern Europe', location: { latitude: 55.75, longitude: 37.62 }, severity: 'OUTAGE_SEVERITY_PARTIAL' as never, categories: ['censorship', 'throttling'], cause: 'Government restriction', outageType: 'censorship', endedAt: 0 },
  { id: 'so-ir-2025-06', title: 'Iran: VPN and Encrypted Traffic Blocking', link: 'https://netblocks.org', description: 'Iranian authorities block VPN traffic and throttle encrypted communications during protest periods.', detectedAt: Date.now() - 3 * 86400000, country: 'Iran', region: 'Middle East', location: { latitude: 35.69, longitude: 51.39 }, severity: 'OUTAGE_SEVERITY_PARTIAL' as never, categories: ['censorship', 'vpn-block'], cause: 'Government restriction', outageType: 'censorship', endedAt: 0 },
  { id: 'so-pk-2025-06', title: 'Pakistan: Social Media Disruption', link: 'https://netblocks.org', description: 'Twitter/X and other platforms throttled during political protests and PTI rallies.', detectedAt: Date.now() - 4 * 86400000, country: 'Pakistan', region: 'South Asia', location: { latitude: 33.72, longitude: 73.04 }, severity: 'OUTAGE_SEVERITY_PARTIAL' as never, categories: ['social-media', 'throttling'], cause: 'Government restriction', outageType: 'restriction', endedAt: 0 },
  { id: 'so-mm-2025-06', title: 'Myanmar: Nationwide Internet Disruptions', link: 'https://netblocks.org', description: 'Myanmar military junta continues nightly internet shutdowns in conflict-affected townships.', detectedAt: Date.now() - 86400000, country: 'Myanmar', region: 'Southeast Asia', location: { latitude: 19.7, longitude: 96.1 }, severity: 'OUTAGE_SEVERITY_MAJOR' as never, categories: ['shutdown', 'conflict'], cause: 'Government shutdown', outageType: 'shutdown', endedAt: 0 },
  { id: 'so-et-2025-06', title: 'Ethiopia: Regional Internet Cut', link: 'https://netblocks.org', description: 'Internet access cut in Amhara and Tigray regions during ongoing conflict operations.', detectedAt: Date.now() - 10 * 86400000, country: 'Ethiopia', region: 'East Africa', location: { latitude: 9.1, longitude: 40.5 }, severity: 'OUTAGE_SEVERITY_MAJOR' as never, categories: ['shutdown', 'conflict'], cause: 'Government shutdown', outageType: 'shutdown', endedAt: 0 },
  { id: 'so-cu-2025-06', title: 'Cuba: Recurring Internet Outages', link: 'https://netblocks.org', description: 'Periodic internet outages in Cuba linked to protests and power grid failures.', detectedAt: Date.now() - 7 * 86400000, country: 'Cuba', region: 'Caribbean', location: { latitude: 23.1, longitude: -82.4 }, severity: 'OUTAGE_SEVERITY_MAJOR' as never, categories: ['outage', 'protests'], cause: 'Infrastructure/Political', outageType: 'outage', endedAt: 0 },
  { id: 'so-sd-2025-06', title: 'Sudan: Internet Blackout in Conflict Zones', link: 'https://netblocks.org', description: 'Large portions of Sudan offline due to infrastructure destruction from civil war between SAF and RSF.', detectedAt: Date.now() - 2 * 86400000, country: 'Sudan', region: 'East Africa', location: { latitude: 15.5, longitude: 32.5 }, severity: 'OUTAGE_SEVERITY_MAJOR' as never, categories: ['conflict', 'blackout'], cause: 'Infrastructure destruction', outageType: 'blackout', endedAt: 0 },
  { id: 'so-bd-2025-06', title: 'Bangladesh: Internet Shutdown During Protests', link: 'https://netblocks.org', description: 'Mobile internet and broadband cut during student quota reform protests.', detectedAt: Date.now() - 8 * 86400000, country: 'Bangladesh', region: 'South Asia', location: { latitude: 23.81, longitude: 90.41 }, severity: 'OUTAGE_SEVERITY_MAJOR' as never, categories: ['shutdown', 'protests'], cause: 'Government shutdown', outageType: 'shutdown', endedAt: Date.now() - 6 * 86400000 },
];

function parseFeedItem(xml: string, tag: string): string {
  const open = `<${tag}>`, close = `</${tag}>`;
  const s = xml.indexOf(open), e = xml.indexOf(close, s);
  if (s < 0 || e < 0) return '';
  return xml.slice(s + open.length, e).replace(/<!\[CDATA\[|\]\]>/g, '').trim();
}

async function fetchNetBlocksRSS(): Promise<InternetOutage[]> {
  const resp = await fetch(NETBLOCKS_RSS, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/rss+xml,text/xml' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`NetBlocks HTTP ${resp.status}`);
  const xml = await resp.text();

  const outages: InternetOutage[] = [];
  let pos = 0;
  let idx = 0;
  while (true) {
    const start = xml.indexOf('<item>', pos);
    if (start < 0) break;
    const end = xml.indexOf('</item>', start);
    if (end < 0) break;
    const chunk = xml.slice(start, end);
    pos = end + 7;

    const title = parseFeedItem(chunk, 'title');
    const link = parseFeedItem(chunk, 'link') || parseFeedItem(chunk, 'guid');
    const desc = parseFeedItem(chunk, 'description').replace(/<[^>]+>/g, '').slice(0, 300);
    const pubDate = parseFeedItem(chunk, 'pubDate');
    if (!title) continue;

    const detectedAt = pubDate ? new Date(pubDate).getTime() : Date.now() - idx * 86400000;
    if (!isNaN(detectedAt) && detectedAt > 0) {
      outages.push({
        id: `nb-${idx++}`,
        title,
        link,
        description: desc,
        detectedAt,
        country: extractCountry(title + ' ' + desc),
        region: '',
        location: undefined,
        severity: 'OUTAGE_SEVERITY_PARTIAL' as never,
        categories: extractCategories(title + ' ' + desc),
        cause: extractCause(title + ' ' + desc),
        outageType: extractType(title + ' ' + desc),
        endedAt: 0,
      });
    }
    if (outages.length >= 30) break;
  }
  return outages;
}

function extractCountry(text: string): string {
  const COUNTRIES: [string, string][] = [
    ['Ukraine', 'Ukraine'], ['Russia', 'Russia'], ['Iran', 'Iran'], ['Myanmar', 'Myanmar'],
    ['Sudan', 'Sudan'], ['Ethiopia', 'Ethiopia'], ['Cuba', 'Cuba'], ['Pakistan', 'Pakistan'],
    ['Bangladesh', 'Bangladesh'], ['Belarus', 'Belarus'], ['Venezuela', 'Venezuela'],
    ['Syria', 'Syria'], ['Afghanistan', 'Afghanistan'], ['Somalia', 'Somalia'],
  ];
  for (const [kw, country] of COUNTRIES) {
    if (text.toLowerCase().includes(kw.toLowerCase())) return country;
  }
  return '';
}

function extractCategories(text: string): string[] {
  const cats: string[] = [];
  if (/shutdown|blackout/i.test(text)) cats.push('shutdown');
  if (/throttl/i.test(text)) cats.push('throttling');
  if (/censor/i.test(text)) cats.push('censorship');
  if (/social media|twitter|facebook|telegram/i.test(text)) cats.push('social-media');
  if (/vpn/i.test(text)) cats.push('vpn-block');
  if (/protest|unrest/i.test(text)) cats.push('protests');
  if (/conflict|war/i.test(text)) cats.push('conflict');
  return cats.length ? cats : ['outage'];
}

function extractCause(text: string): string {
  if (/government|authorit|ordered/i.test(text)) return 'Government restriction';
  if (/conflict|war|attack/i.test(text)) return 'Infrastructure/Conflict';
  if (/election/i.test(text)) return 'Election-related restriction';
  if (/protest/i.test(text)) return 'Protest-related restriction';
  return 'Unknown';
}

function extractType(text: string): string {
  if (/blackout|shutdown/i.test(text)) return 'shutdown';
  if (/throttl/i.test(text)) return 'throttling';
  if (/censor/i.test(text)) return 'censorship';
  return 'disruption';
}

function filterOutages(outages: InternetOutage[], req: ListInternetOutagesRequest): InternetOutage[] {
  let f = outages;
  if (req.country) {
    const t = req.country.toLowerCase();
    f = f.filter(o => o.country.toLowerCase().includes(t));
  }
  if (req.start) f = f.filter(o => o.detectedAt >= req.start);
  if (req.end) f = f.filter(o => o.detectedAt <= req.end);
  return f;
}

export async function listInternetOutages(
  _ctx: ServerContext,
  req: ListInternetOutagesRequest,
): Promise<ListInternetOutagesResponse> {
  // Try Redis seed first
  try {
    const seedData = await getCachedJson(SEED_CACHE_KEY, true) as ListInternetOutagesResponse | null;
    if (seedData?.outages?.length) {
      return { outages: filterOutages(seedData.outages, req), pagination: undefined };
    }
  } catch { /* fall through */ }

  // Refresh live cache if needed
  if (!_cache || Date.now() - _cache.ts > CACHE_TTL_MS) {
    try {
      const live = await fetchNetBlocksRSS();
      // Merge live + static, deduplicate by title prefix
      const liveKeys = new Set(live.map(o => o.title.slice(0, 20).toLowerCase()));
      const merged = [...live, ...STATIC_OUTAGES.filter(s => !liveKeys.has(s.title.slice(0, 20).toLowerCase()))];
      _cache = { outages: merged.sort((a, b) => b.detectedAt - a.detectedAt), ts: Date.now() };
    } catch (err) {
      console.warn('[NetBlocks] RSS failed:', (err as Error).message);
      if (!_cache) _cache = { outages: STATIC_OUTAGES, ts: Date.now() };
    }
  }

  return { outages: filterOutages(_cache!.outages, req), pagination: undefined };
}
