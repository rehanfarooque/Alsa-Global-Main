/**
 * ListClimateNews RPC
 *
 * Read order:
 *   1. Seeded Redis cache (Railway path).
 *   2. Direct RSS fetch from the same climate-focused feeds the seed script
 *      uses (Carbon Brief, Guardian Environment, Inside Climate News, etc.).
 *      In-process cache for 20 minutes so panel refreshes don't hammer the
 *      publishers.
 */

import type {
  ClimateServiceHandler,
  ServerContext,
  ListClimateNewsRequest,
  ListClimateNewsResponse,
  ClimateNewsItem,
} from '../../../../src/generated/server/alsaglobal/climate/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { CLIMATE_NEWS_KEY } from '../../../_shared/cache-keys';
import { CHROME_UA } from '../../../_shared/constants';

const FEEDS: Array<{ sourceName: string; url: string }> = [
  { sourceName: 'Carbon Brief', url: 'https://www.carbonbrief.org/feed' },
  { sourceName: 'The Guardian Environment', url: 'https://www.theguardian.com/environment/climate-crisis/rss' },
  { sourceName: 'Inside Climate News', url: 'https://insideclimatenews.org/feed/' },
  { sourceName: 'Phys.org Earth Science', url: 'https://phys.org/rss-feed/earth-news/earth-sciences/' },
];
const FEED_TIMEOUT_MS = 8_000;
const MEM_TTL_MS = 20 * 60_000;
let _memCache: { result: ListClimateNewsResponse; ts: number } | null = null;

function extractTag(block: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (!m) return '';
  let v = m[1]!.trim();
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(v);
  if (cdata) v = cdata[1]!.trim();
  return v.replace(/<[^>]+>/g, '').trim();
}

function stableHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

async function fetchFeed(sourceName: string, url: string): Promise<ClimateNewsItem[]> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/rss+xml,application/xml,text/xml,*/*' },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!resp.ok) return [];
  const xml = await resp.text();
  const entries = xml.split(/<item[\s>]/).slice(1);
  const items: ClimateNewsItem[] = [];
  for (const raw of entries.slice(0, 10)) {
    const block = raw.includes('</item>') ? raw.split('</item>')[0]! : raw;
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link') || (/<link[^>]*href="([^"]+)"/.exec(block)?.[1] ?? '');
    const pub = extractTag(block, 'pubDate') || extractTag(block, 'dc:date');
    const publishedAt = pub ? new Date(pub).getTime() : 0;
    if (!title || !link || !publishedAt) continue;
    items.push({
      id: `${stableHash(link)}-${publishedAt}`,
      title,
      url: link,
      sourceName,
      publishedAt,
      summary: extractTag(block, 'description').slice(0, 280),
    });
  }
  return items;
}

async function fetchClimateNewsDirect(): Promise<ListClimateNewsResponse> {
  if (_memCache && Date.now() - _memCache.ts < MEM_TTL_MS) return _memCache.result;

  const settled = await Promise.allSettled(FEEDS.map((f) => fetchFeed(f.sourceName, f.url)));
  const items: ClimateNewsItem[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') items.push(...r.value);
  }
  items.sort((a, b) => b.publishedAt - a.publishedAt);
  const result: ListClimateNewsResponse = {
    items: items.slice(0, 30),
    fetchedAt: Date.now(),
  };
  if (result.items.length > 0) _memCache = { result, ts: Date.now() };
  return result;
}

export const listClimateNews: ClimateServiceHandler['listClimateNews'] = async (
  _ctx: ServerContext,
  _req: ListClimateNewsRequest,
): Promise<ListClimateNewsResponse> => {
  try {
    const cached = await getCachedJson(CLIMATE_NEWS_KEY, true) as ListClimateNewsResponse | null;
    if (cached?.items?.length) return cached;
  } catch {
    // fall through
  }
  try {
    return await fetchClimateNewsDirect();
  } catch (err) {
    console.warn('[listClimateNews] direct fetch failed:', (err as Error).message);
    return { items: [], fetchedAt: 0 };
  }
};
