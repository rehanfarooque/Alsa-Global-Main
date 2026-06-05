/**
 * ListPredictionMarkets RPC — fetches live from Polymarket Gamma API (free, no key).
 * Falls back to curated static data if Gamma is unreachable.
 */

import {
  type MarketSource,
  type PredictionServiceHandler,
  type ServerContext,
  type ListPredictionMarketsRequest,
  type ListPredictionMarketsResponse,
  type PredictionMarket,
} from '../../../../src/generated/server/alsaglobal/prediction/v1/service_server';

import { clampInt } from '../../../_shared/constants';

const GAMMA_BASE = 'https://gamma-api.polymarket.com/markets';
const CACHE_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 12_000;

interface GammaMarket {
  id: string;
  question: string;
  slug: string;
  endDate?: string;
  volumeNum?: number;
  outcomePrices?: string;
  active?: boolean;
  closed?: boolean;
}

let _cache: { markets: PredictionMarket[]; ts: number } | null = null;

// Keywords used to classify markets into categories
const GEO_KWS = ['russia', 'ukraine', 'ceasefire', 'china', 'taiwan', 'iran', 'nato', 'nuclear', 'coup', 'invasion', 'north korea', 'middle east', 'israel', 'gaza', 'hamas', 'putin', 'zelensky', 'war', 'military strike', 'sanctions'];
const FIN_KWS = ['fed rate', 'rate cut', 'recession', 'inflation', 'sp 500', 'sp500', 's&p 500', 'bitcoin', 'btc', 'gold price', 'oil price', 'gdp', 'unemployment', 'interest rate', 'ethereum', 'fed funds', 'treasury', 'tariff', 'trade war', 'debt'];
const TECH_KWS = ['gpt', 'openai', 'agi', 'quantum', 'spacex', 'starship', 'nvidia', 'apple stock', 'microsoft stock'];

function classifyMarket(question: string): string {
  const q = question.toLowerCase();
  if (GEO_KWS.some((k) => q.includes(k))) return 'geopolitical';
  if (FIN_KWS.some((k) => q.includes(k))) return 'finance';
  if (TECH_KWS.some((k) => q.includes(k))) return 'tech';
  return 'geopolitical';
}

function gammaToProto(m: GammaMarket): PredictionMarket {
  let yesPrice = 0.5;
  try {
    const prices = JSON.parse(m.outcomePrices ?? '[0.5,0.5]') as number[];
    yesPrice = Number(prices[0]) || 0.5;
  } catch { /* keep default */ }

  const category = classifyMarket(m.question);
  return {
    id: m.id,
    title: m.question,
    yesPrice,
    volume: m.volumeNum ?? 0,
    url: `https://polymarket.com/event/${m.slug}`,
    closesAt: m.endDate ? Date.parse(m.endDate) : 0,
    category,
    source: 'MARKET_SOURCE_POLYMARKET' as MarketSource,
  };
}

async function fetchGammaMarkets(): Promise<PredictionMarket[]> {
  // Fetch two pages of top-volume markets to get good coverage across categories
  const pages = await Promise.all([
    fetch(`${GAMMA_BASE}?closed=false&limit=100&order=volumeNum&ascending=false&offset=0`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    }),
    fetch(`${GAMMA_BASE}?closed=false&limit=100&order=volumeNum&ascending=false&offset=100`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    }),
  ]);

  const all: GammaMarket[] = [];
  for (const resp of pages) {
    if (!resp.ok) continue;
    const data = await resp.json() as GammaMarket[];
    if (Array.isArray(data)) all.push(...data);
  }

  return all.map(gammaToProto);
}

const STATIC_MARKETS: PredictionMarket[] = [
  // Geopolitical
  { id: 'iran-regime-fall-2026', title: 'Will the Iranian regime fall before 2027?', yesPrice: 0.135, volume: 19300000, url: 'https://polymarket.com/event/iranian-regime-fall-2027', closesAt: Date.parse('2026-12-31'), category: 'geopolitical', source: 'MARKET_SOURCE_POLYMARKET' as MarketSource },
  { id: 'us-invade-iran-2027', title: 'Will the U.S. invade Iran before 2027?', yesPrice: 0.165, volume: 33800000, url: 'https://polymarket.com/event/us-invade-iran-2027', closesAt: Date.parse('2026-12-31'), category: 'geopolitical', source: 'MARKET_SOURCE_POLYMARKET' as MarketSource },
  { id: 'china-taiwan-2026', title: 'Will China invade Taiwan by end of 2026?', yesPrice: 0.062, volume: 32000000, url: 'https://polymarket.com/event/china-invade-taiwan-2026', closesAt: Date.parse('2026-12-31'), category: 'geopolitical', source: 'MARKET_SOURCE_POLYMARKET' as MarketSource },
  { id: 'iran-us-peace-2026', title: 'US x Iran permanent peace deal by June 30, 2026?', yesPrice: 0.245, volume: 18000000, url: 'https://polymarket.com/event/us-iran-peace-deal-june-2026', closesAt: Date.parse('2026-06-30'), category: 'geopolitical', source: 'MARKET_SOURCE_POLYMARKET' as MarketSource },
  // Finance
  { id: 'bitcoin-150k-june-2026', title: 'Will Bitcoin hit $150k by June 30, 2026?', yesPrice: 0.004, volume: 19700000, url: 'https://polymarket.com/event/bitcoin-150k-june-2026', closesAt: Date.parse('2026-06-30'), category: 'finance', source: 'MARKET_SOURCE_POLYMARKET' as MarketSource },
  { id: 'fed-cut-june-2026', title: 'Will the Fed decrease interest rates 50+ bps at June meeting?', yesPrice: 0.004, volume: 13600000, url: 'https://polymarket.com/event/fed-rate-june-2026', closesAt: Date.parse('2026-06-20'), category: 'finance', source: 'MARKET_SOURCE_POLYMARKET' as MarketSource },
  // Tech
  { id: 'openai-gpt5-2025', title: 'Will OpenAI release GPT-5 in 2025?', yesPrice: 0.78, volume: 5600000, url: 'https://polymarket.com/event/openai-gpt5-2025', closesAt: Date.parse('2025-12-31'), category: 'tech', source: 'MARKET_SOURCE_POLYMARKET' as MarketSource },
  { id: 'agi-2030', title: 'Will AGI be achieved before 2030?', yesPrice: 0.20, volume: 7200000, url: 'https://polymarket.com/event/agi-2030', closesAt: Date.parse('2030-01-01'), category: 'tech', source: 'MARKET_SOURCE_POLYMARKET' as MarketSource },
];

export const listPredictionMarkets: PredictionServiceHandler['listPredictionMarkets'] = async (
  _ctx: ServerContext,
  req: ListPredictionMarketsRequest,
): Promise<ListPredictionMarketsResponse> => {
  try {
    const category = (req.category || '').slice(0, 50).toLowerCase();
    const query = (req.query || '').slice(0, 100);
    const limit = req.pageSize > 0 ? clampInt(req.pageSize, 50, 1, 100) : 50;

    // Serve from cache if fresh
    if (!_cache || Date.now() - _cache.ts > CACHE_TTL_MS) {
      try {
        const live = await fetchGammaMarkets();
        if (live.length > 0) {
          _cache = { markets: live, ts: Date.now() };
        }
      } catch (err) {
        console.warn('[PredictionMarkets] Gamma API failed:', (err as Error).message);
      }
    }

    const allMarkets = _cache?.markets ?? STATIC_MARKETS;

    const isTech = category && ['ai', 'tech', 'crypto', 'science'].includes(category);
    const isFinance = !isTech && category && ['economy', 'fed', 'inflation', 'interest-rates', 'recession', 'trade', 'tariffs', 'debt-ceiling', 'finance'].includes(category);

    let markets = allMarkets;
    if (isTech) {
      markets = allMarkets.filter((m) => m.category === 'tech');
    } else if (isFinance) {
      markets = allMarkets.filter((m) => m.category === 'finance');
    } else if (category && category !== '') {
      markets = allMarkets.filter((m) => m.category === 'geopolitical');
    }

    if (query) {
      const q = query.toLowerCase();
      markets = markets.filter((m) => m.title.toLowerCase().includes(q));
    }

    // Sort by volume descending
    markets = [...markets].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));

    return { markets: markets.slice(0, limit), pagination: undefined };
  } catch {
    return { markets: STATIC_MARKETS.slice(0, 8), pagination: undefined };
  }
};
