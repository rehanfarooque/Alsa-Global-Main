import type {
  ServerContext,
  ListSecurityAdvisoriesRequest,
  ListSecurityAdvisoriesResponse,
} from '../../../../src/generated/server/alsaglobal/intelligence/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { fetchAdvisoriesDirect } from './_advisories-direct';

const ADVISORY_KEY = 'intelligence:advisories:v1';

export async function listSecurityAdvisories(
  _ctx: ServerContext,
  _req: ListSecurityAdvisoriesRequest,
): Promise<ListSecurityAdvisoriesResponse> {
  // 1. Seeded Redis cache (Railway path — ~20 embassy + health feeds)
  try {
    const data = (await getCachedJson(ADVISORY_KEY, true)) as {
      advisories: Array<{ title: string; link: string; pubDate: string; source: string; sourceCountry: string; level: string; country: string }>;
      byCountry: Record<string, string>;
    } | null;

    if (data?.advisories?.length) {
      return {
        advisories: data.advisories.map(a => ({
          title: a.title,
          link: a.link,
          pubDate: a.pubDate,
          source: a.source,
          sourceCountry: a.sourceCountry,
          level: a.level,
          country: a.country,
        })),
        byCountry: data.byCountry || {},
      };
    }
  } catch (err: unknown) {
    console.warn('[SecurityAdvisories] Redis read error:', err instanceof Error ? err.message : err);
  }

  // 2. Direct RSS fetch (self-host path — US State Dept + CDC + WHO, free)
  try {
    return await fetchAdvisoriesDirect();
  } catch (err) {
    console.warn('[SecurityAdvisories] direct fetch failed:', (err as Error).message);
    return { advisories: [], byCountry: {} };
  }
}
