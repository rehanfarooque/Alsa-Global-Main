/**
 * Direct travel-advisory RSS fetcher — no-Redis fallback for the Security
 * Advisories panel. Pulls the US State Department's travel-advisory RSS
 * (every country, with Level 1-4) plus the CDC and WHO health feeds directly
 * — all free, no key. Cached in-process for 60 minutes.
 *
 * The Railway seed uses an RSS proxy + ~20 embassy feeds; this leaner direct
 * version covers the canonical level-bearing source so the panel is populated
 * on a fresh self-host.
 */

import { CHROME_UA } from '../../../_shared/constants';
import countryNames from '../../../../shared/country-names.json';
import type { SecurityAdvisoryItem } from '../../../../src/generated/server/alsaglobal/intelligence/v1/service_server';

const TIMEOUT_MS = 15_000;
const MEM_TTL_MS = 60 * 60_000;

interface AdvisoryFeed {
  name: string;
  sourceCountry: string;
  url: string;
  levelParser?: 'us';
}

const FEEDS: AdvisoryFeed[] = [
  { name: 'US State Dept', sourceCountry: 'US', url: 'https://travel.state.gov/_res/rss/TAsTWs.xml', levelParser: 'us' },
  { name: 'CDC Travel Notices', sourceCountry: 'US', url: 'https://wwwnc.cdc.gov/travel/rss/notices.xml' },
  { name: 'WHO News', sourceCountry: 'INT', url: 'https://www.who.int/rss-feeds/news-english.xml' },
];

const COUNTRY_NAMES = countryNames as Record<string, string>;
const SORTED_COUNTRY_ENTRIES = Object.entries(COUNTRY_NAMES).sort((a, b) => b[0].length - a[0].length);

const LEVEL_RANK: Record<string, number> = {
  'do-not-travel': 4, reconsider: 3, caution: 2, normal: 1, info: 0,
};

function parseUsLevel(title: string): string {
  const m = title.match(/Level (\d)/i);
  if (!m) return 'info';
  return ({ '4': 'do-not-travel', '3': 'reconsider', '2': 'caution', '1': 'normal' } as Record<string, string>)[m[1]!] ?? 'info';
}

function stripHtml(html: string): string {
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

function parseRssItems(xml: string): Array<{ title: string; link: string; pubDate: string }> {
  const items: Array<{ title: string; link: string; pubDate: string }> = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1]!;
    const title = stripHtml((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const link = stripHtml((block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '');
    const pubDate = stripHtml((block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] || '');
    items.push({ title, link, pubDate });
  }
  return items;
}

function extractCountry(title: string, feed: AdvisoryFeed): string {
  if (feed.sourceCountry === 'INT') return '';
  const normalized = title.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/['.(),/-]/g, ' ').replace(/\s+/g, ' ');
  for (const [name, code] of SORTED_COUNTRY_ENTRIES) {
    if (normalized.includes(name)) return code;
  }
  return '';
}

function isValidUrl(link: string): boolean {
  try {
    const u = new URL(link);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

async function fetchFeed(feed: AdvisoryFeed): Promise<SecurityAdvisoryItem[]> {
  try {
    const resp = await fetch(feed.url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) return [];
    const xml = await resp.text();
    return parseRssItems(xml).slice(0, 30)
      .filter((item) => item.title && isValidUrl(item.link))
      .map((item) => ({
        title: item.title,
        link: item.link,
        pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
        source: feed.name,
        sourceCountry: feed.sourceCountry,
        level: feed.levelParser === 'us' ? parseUsLevel(item.title) : 'info',
        country: extractCountry(item.title, feed),
      }));
  } catch {
    return [];
  }
}

let _memCache: { advisories: SecurityAdvisoryItem[]; byCountry: Record<string, string>; ts: number } | null = null;

export async function fetchAdvisoriesDirect(): Promise<{ advisories: SecurityAdvisoryItem[]; byCountry: Record<string, string> }> {
  if (_memCache && Date.now() - _memCache.ts < MEM_TTL_MS) {
    return { advisories: _memCache.advisories, byCountry: _memCache.byCountry };
  }

  const results = await Promise.allSettled(FEEDS.map((f) => fetchFeed(f)));
  const advisories: SecurityAdvisoryItem[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const a of r.value) {
      const key = a.link || a.title;
      if (seen.has(key)) continue;
      seen.add(key);
      advisories.push(a);
    }
  }

  const byCountry: Record<string, string> = {};
  for (const a of advisories) {
    if (!a.country || !a.level || a.level === 'info') continue;
    const existing = byCountry[a.country];
    if (!existing || (LEVEL_RANK[a.level] ?? 0) > (LEVEL_RANK[existing] ?? 0)) {
      byCountry[a.country] = a.level;
    }
  }

  if (advisories.length > 0) _memCache = { advisories, byCountry, ts: Date.now() };
  return { advisories, byCountry };
}
