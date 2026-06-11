/**
 * RPC: listHackernewsItems
 *
 * Read order:
 *   1. Seeded Redis cache (Railway path) — instant.
 *   2. Direct HackerNews Firebase API when cache is empty (self-host path).
 *      In-process memory cache for 5 minutes so a popular dashboard tab
 *      doesn't re-fetch every render.
 *
 * The HN Firebase API requires no key and rate-limits generously.
 */

import type {
  ServerContext,
  ListHackernewsItemsRequest,
  ListHackernewsItemsResponse,
  HackernewsItem,
} from '../../../../src/generated/server/alsaglobal/research/v1/service_server';

import { clampInt, CHROME_UA } from '../../../_shared/constants';
import { getCachedJson } from '../../../_shared/redis';

const SEED_KEY_PREFIX = 'research:hackernews:v1';
const ALLOWED_HN_FEEDS = new Set(['top', 'new', 'best', 'ask', 'show', 'job']);
const HN_BASE = 'https://hacker-news.firebaseio.com/v0';
const MEM_TTL_MS = 5 * 60_000;
const ITEM_FETCH_TIMEOUT_MS = 4_500;

const _memCache = new Map<string, { items: HackernewsItem[]; ts: number }>();

interface HNFirebaseItem {
  id: number;
  title?: string;
  url?: string;
  text?: string;
  score?: number;
  descendants?: number;
  by?: string;
  time?: number;
  type?: string;
}

async function fetchHnDirect(feedType: string, pageSize: number): Promise<HackernewsItem[]> {
  const cacheKey = `${feedType}:${pageSize}`;
  const hit = _memCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < MEM_TTL_MS) return hit.items;

  // 1. Get the list of top item IDs for the feed
  const listUrl = `${HN_BASE}/${feedType}stories.json`;
  const listResp = await fetch(listUrl, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(ITEM_FETCH_TIMEOUT_MS),
  });
  if (!listResp.ok) throw new Error(`HN list HTTP ${listResp.status}`);
  const ids = await listResp.json() as number[];
  if (!Array.isArray(ids) || ids.length === 0) return [];

  // 2. Fetch each top-N item in parallel (Firebase tolerates burst reads)
  const slice = ids.slice(0, Math.min(pageSize, 50));
  const detailUrls = slice.map((id) => `${HN_BASE}/item/${id}.json`);
  const detailResps = await Promise.allSettled(
    detailUrls.map((u) => fetch(u, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(ITEM_FETCH_TIMEOUT_MS),
    }).then((r) => r.ok ? r.json() as Promise<HNFirebaseItem> : null)),
  );

  const items: HackernewsItem[] = [];
  for (const r of detailResps) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const it = r.value;
    if (!it.title) continue;
    items.push({
      id: it.id,
      title: it.title,
      // Ask/Show/Job posts often have no `url`; point at the HN comments page so
      // the link is always live.
      url: it.url || `https://news.ycombinator.com/item?id=${it.id}`,
      score: it.score ?? 0,
      commentCount: it.descendants ?? 0,
      by: it.by ?? '',
      submittedAt: (it.time ?? 0) * 1000,
    });
  }
  _memCache.set(cacheKey, { items, ts: Date.now() });
  return items;
}

export async function listHackernewsItems(
  _ctx: ServerContext,
  req: ListHackernewsItemsRequest,
): Promise<ListHackernewsItemsResponse> {
  const feedType = ALLOWED_HN_FEEDS.has(req.feedType) ? req.feedType : 'top';
  const pageSize = clampInt(req.pageSize, 30, 1, 100);

  try {
    const seedKey = `${SEED_KEY_PREFIX}:${feedType}:30`;
    const cached = await getCachedJson(seedKey, true) as ListHackernewsItemsResponse | null;
    if (cached?.items?.length) {
      return { items: cached.items.slice(0, pageSize), pagination: undefined };
    }
  } catch {
    // Redis missing or unreachable — fall through to direct fetch.
  }

  try {
    const items = await fetchHnDirect(feedType, pageSize);
    return { items, pagination: undefined };
  } catch (err) {
    console.warn('[listHackernewsItems] direct fetch failed:', (err as Error).message);
    return { items: [], pagination: undefined };
  }
}
