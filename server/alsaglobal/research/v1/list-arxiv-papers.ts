/**
 * RPC: listArxivPapers
 *
 * Read order:
 *   1. Seeded Redis cache.
 *   2. Direct arXiv export API (https://export.arxiv.org/api/query). Free,
 *      no key, returns Atom XML. Cached in-process for 15 minutes — arXiv
 *      asks aggregators to throttle at one query every 3 seconds.
 */

import type {
  ServerContext,
  ListArxivPapersRequest,
  ListArxivPapersResponse,
  ArxivPaper,
} from '../../../../src/generated/server/alsaglobal/research/v1/service_server';

import { clampInt, CHROME_UA } from '../../../_shared/constants';
import { getCachedJson } from '../../../_shared/redis';

const SEED_KEY_PREFIX = 'research:arxiv:v1';
const ARXIV_BASE = 'https://export.arxiv.org/api/query';
const MEM_TTL_MS = 15 * 60_000;
const ARXIV_TIMEOUT_MS = 6_000;
const _memCache = new Map<string, { papers: ArxivPaper[]; ts: number }>();

function extract(block: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
  return m ? m[1]!.trim() : '';
}

function extractAll(block: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    out.push(m[1]!.trim());
  }
  return out;
}

async function fetchArxivDirect(category: string, pageSize: number): Promise<ArxivPaper[]> {
  const cacheKey = `${category}:${pageSize}`;
  const hit = _memCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < MEM_TTL_MS) return hit.papers;

  const max = Math.min(pageSize, 100);
  const url = `${ARXIV_BASE}?search_query=cat:${encodeURIComponent(category)}&sortBy=submittedDate&sortOrder=descending&max_results=${max}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/atom+xml' },
    signal: AbortSignal.timeout(ARXIV_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`arXiv HTTP ${resp.status}`);
  const xml = await resp.text();

  const entries = xml.split('<entry>').slice(1);
  const papers: ArxivPaper[] = [];
  for (const raw of entries) {
    const block = raw.includes('</entry>') ? raw.split('</entry>')[0]! : raw;
    const idUrl = extract(block, 'id');
    const arxivId = idUrl.split('/abs/').pop() ?? idUrl;
    const title = extract(block, 'title').replace(/\s+/g, ' ');
    if (!title) continue;
    const summary = extract(block, 'summary').replace(/\s+/g, ' ');
    const published = extract(block, 'published');
    const authors = extractAll(block, 'name');
    // arXiv categories live as <category term="cs.AI" .../>; the term attribute
    // is what callers want.
    const categories: string[] = [];
    const catRe = /<category\b[^>]*term="([^"]+)"/g;
    let cm: RegExpExecArray | null;
    while ((cm = catRe.exec(block)) !== null) categories.push(cm[1]!);

    papers.push({
      id: arxivId,
      title,
      summary,
      authors,
      categories,
      publishedAt: published ? new Date(published).getTime() : 0,
      url: idUrl || `https://arxiv.org/abs/${arxivId}`,
    });
  }
  _memCache.set(cacheKey, { papers, ts: Date.now() });
  return papers;
}

export async function listArxivPapers(
  _ctx: ServerContext,
  req: ListArxivPapersRequest,
): Promise<ListArxivPapersResponse> {
  const category = req.category || 'cs.AI';
  const pageSize = clampInt(req.pageSize, 50, 1, 100);

  try {
    const seedKey = `${SEED_KEY_PREFIX}:${category}::50`;
    const cached = await getCachedJson(seedKey, true) as ListArxivPapersResponse | null;
    if (cached?.papers?.length) {
      return { papers: cached.papers.slice(0, pageSize), pagination: undefined };
    }
  } catch {
    // fall through to direct
  }

  try {
    const papers = await fetchArxivDirect(category, pageSize);
    return { papers, pagination: undefined };
  } catch (err) {
    console.warn('[listArxivPapers] direct fetch failed:', (err as Error).message);
    return { papers: [], pagination: undefined };
  }
}
