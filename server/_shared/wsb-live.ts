/**
 * Live WSB ticker-mentions fetcher — ApeWisdom public API.
 *
 * Used by the Vite dev/self-host bootstrap shim when the Railway-seeded
 * `intelligence:wsb-tickers:v1` Redis key is unavailable. ApeWisdom
 * aggregates mention counts across r/wallstreetbets and related subs and
 * requires no API key.
 *
 * Output matches the WsbTicker shape the panel expects
 * (src/components/WsbTickerScannerPanel.ts).
 */

const APEWISDOM_URL = 'https://apewisdom.io/api/v1.0/filter/wallstreetbets/page/1';
const TIMEOUT_MS = 8_000;
const MEM_TTL_MS = 10 * 60_000;

export interface WsbTickerLive {
  symbol: string;
  mentionCount: number;
  uniquePosts: number;
  totalScore: number;
  avgUpvoteRatio: number;
  subreddits: string[];
  velocityScore: number;
}

interface ApeWisdomEntry {
  rank?: number;
  ticker?: string;
  mentions?: number;
  upvotes?: number;
  rank_24h_ago?: number;
  mentions_24h_ago?: number;
}

let _cache: { tickers: WsbTickerLive[]; ts: number } | null = null;

export async function fetchWsbTickersLive(): Promise<WsbTickerLive[]> {
  if (_cache && Date.now() - _cache.ts < MEM_TTL_MS) return _cache.tickers;

  const resp = await fetch(APEWISDOM_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`ApeWisdom HTTP ${resp.status}`);
  const body = await resp.json() as { results?: ApeWisdomEntry[] };
  const rows = Array.isArray(body.results) ? body.results : [];

  const tickers: WsbTickerLive[] = rows
    .filter((r) => r.ticker && (r.mentions ?? 0) > 0)
    .slice(0, 25)
    .map((r) => {
      const mentions = r.mentions ?? 0;
      const mentionsPrev = r.mentions_24h_ago ?? 0;
      // Velocity: percentage growth in mentions over 24h, clamped to 0-100.
      // A ticker that doubled its mentions scores 100; flat scores 0.
      const growth = mentionsPrev > 0 ? ((mentions - mentionsPrev) / mentionsPrev) * 100 : (mentions > 0 ? 100 : 0);
      const velocityScore = Math.max(0, Math.min(100, Math.round(growth)));
      return {
        symbol: (r.ticker ?? '').toUpperCase(),
        mentionCount: mentions,
        // ApeWisdom aggregates mentions without exposing distinct post counts;
        // the panel doesn't render this field, so 0 is honest rather than fake.
        uniquePosts: 0,
        totalScore: r.upvotes ?? 0,
        avgUpvoteRatio: 0,
        subreddits: ['wallstreetbets'],
        velocityScore,
      };
    });

  if (tickers.length > 0) _cache = { tickers, ts: Date.now() };
  return tickers;
}
