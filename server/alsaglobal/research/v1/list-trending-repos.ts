/**
 * RPC: listTrendingRepos
 *
 * Read order:
 *   1. Seeded Redis cache.
 *   2. GitHub public search API — `q=created:>YYYY-MM-DD&sort=stars` returns
 *      recent repos ordered by stargazer count, which is what "trending"
 *      practically means without OSSInsight's curated list.
 *
 * GitHub's unauthenticated rate limit is 60 req/h per IP, which is fine for
 * a dashboard — we cache in-process for 15 minutes per (language, period).
 */

import type {
  ServerContext,
  ListTrendingReposRequest,
  ListTrendingReposResponse,
  GithubRepo,
} from '../../../../src/generated/server/alsaglobal/research/v1/service_server';

import { clampInt, CHROME_UA } from '../../../_shared/constants';
import { getCachedJson } from '../../../_shared/redis';

const SEED_KEY_PREFIX = 'research:trending:v1';
const GITHUB_BASE = 'https://api.github.com/search/repositories';
const MEM_TTL_MS = 15 * 60_000;
const GITHUB_TIMEOUT_MS = 6_000;
const _memCache = new Map<string, { repos: GithubRepo[]; ts: number }>();

interface GithubSearchItem {
  full_name?: string;
  description?: string | null;
  language?: string | null;
  stargazers_count?: number;
  forks_count?: number;
  html_url?: string;
}

function periodToDateCutoff(period: string): string {
  const now = new Date();
  const days = period === 'monthly' ? 30 : period === 'weekly' ? 7 : 1;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return cutoff.toISOString().slice(0, 10);
}

async function fetchTrendingDirect(language: string, period: string, pageSize: number): Promise<GithubRepo[]> {
  const cacheKey = `${language}:${period}:${pageSize}`;
  const hit = _memCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < MEM_TTL_MS) return hit.repos;

  const cutoff = periodToDateCutoff(period);
  // "language:python created:>2024-...-..." selects recent repos in that lang.
  // sort=stars + order=desc orders them by total stars — the standard proxy
  // for trending used by github-trending-style sites.
  const q = `language:${language} created:>${cutoff}`;
  const url = `${GITHUB_BASE}?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${Math.min(pageSize, 50)}`;
  const headers: Record<string, string> = {
    'User-Agent': CHROME_UA,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  // Optional token bumps the per-IP rate limit from 60/h to 5000/h.
  const token = process.env.GITHUB_API_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const resp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`GitHub HTTP ${resp.status}`);
  const body = await resp.json() as { items?: GithubSearchItem[] };
  const items = body.items ?? [];

  const repos: GithubRepo[] = items.map((it) => ({
    fullName: it.full_name ?? '',
    description: it.description ?? '',
    language: it.language ?? language,
    stars: it.stargazers_count ?? 0,
    // "stars today" isn't available without OSSInsight's daily snapshot diff —
    // omit. Clients render 0 as "—" already.
    starsToday: 0,
    forks: it.forks_count ?? 0,
    url: it.html_url ?? '',
  })).filter((r) => r.fullName);

  _memCache.set(cacheKey, { repos, ts: Date.now() });
  return repos;
}

export async function listTrendingRepos(
  _ctx: ServerContext,
  req: ListTrendingReposRequest,
): Promise<ListTrendingReposResponse> {
  const language = req.language || 'python';
  const period = req.period || 'daily';
  const pageSize = clampInt(req.pageSize, 50, 1, 100);

  try {
    const seedKey = `${SEED_KEY_PREFIX}:${language}:${period}:50`;
    const cached = await getCachedJson(seedKey, true) as ListTrendingReposResponse | null;
    if (cached?.repos?.length) {
      return { repos: cached.repos.slice(0, pageSize), pagination: undefined };
    }
  } catch {
    // fall through to direct
  }

  try {
    const repos = await fetchTrendingDirect(language, period, pageSize);
    return { repos, pagination: undefined };
  } catch (err) {
    console.warn('[listTrendingRepos] direct fetch failed:', (err as Error).message);
    return { repos: [], pagination: undefined };
  }
}
