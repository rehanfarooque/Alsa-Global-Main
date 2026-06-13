/**
 * AlsaGlobal: ListGulfQuotes — GCC indices + commodities via Stooq.
 *
 * Indices via US-listed ETFs (iShares MSCI series):
 *   UAE  → uae.us   Kuwait → kwt.us
 *   QAT  → qat.us   Saudi TASI → ^tasi (direct)
 *
 * Commodities critical to Gulf economies:
 *   Brent Crude → cb.f   WTI Crude → cl.f   Gold → gc.f
 */

import type {
  ServerContext,
  ListGulfQuotesRequest,
  ListGulfQuotesResponse,
  GulfQuote,
} from '../../../../src/generated/server/alsaglobal/market/v1/service_server';
import { fetchQuote } from './_shared';

// Yahoo-style symbols routed through the unified fetchQuote cascade (Yahoo →
// free fallbacks → Stooq), so GCC assets resolve from VPS IPs that Stooq
// blocks. type: 'index' | 'currency' | 'commodity'
const GULF_ASSETS: Array<Omit<GulfQuote, 'price' | 'change' | 'sparkline'> & { fetchSymbol: string }> = [
  // Saudi Arabia direct index (Yahoo carries ^TASI)
  { symbol: '^TASI',   fetchSymbol: '^TASI',  name: 'Saudi Tadawul (TASI)',   flag: '🇸🇦', country: 'Saudi Arabia', type: 'index'     },
  // US-listed GCC ETFs (iShares MSCI series) — Yahoo carries these directly
  { symbol: 'UAE',     fetchSymbol: 'UAE',    name: 'UAE Market (iShares)',   flag: '🇦🇪', country: 'UAE',          type: 'index'     },
  { symbol: 'QAT',     fetchSymbol: 'QAT',    name: 'Qatar Market (iShares)', flag: '🇶🇦', country: 'Qatar',        type: 'index'     },
  { symbol: 'KWT',     fetchSymbol: 'KWT',    name: 'Kuwait Market (iShares)',flag: '🇰🇼', country: 'Kuwait',       type: 'index'     },
  // Gulf-critical commodities (Yahoo futures; metals via gold-api fallback)
  { symbol: 'BZ=F',    fetchSymbol: 'BZ=F',   name: 'Brent Crude Oil',        flag: '🛢️',  country: '',             type: 'commodity' },
  { symbol: 'CL=F',    fetchSymbol: 'CL=F',   name: 'WTI Crude Oil',          flag: '🛢️',  country: '',             type: 'commodity' },
  { symbol: 'GC=F',    fetchSymbol: 'GC=F',   name: 'Gold (Comex)',            flag: '🥇',  country: '',             type: 'commodity' },
];

export async function listGulfQuotes(
  _ctx: ServerContext,
  _req: ListGulfQuotesRequest,
): Promise<ListGulfQuotesResponse> {
  try {
    const results = await Promise.allSettled(
      GULF_ASSETS.map(async ({ fetchSymbol, ...meta }) => {
        const q = await fetchQuote(fetchSymbol);
        if (!q) return null;
        return { ...meta, price: q.price, change: q.change, sparkline: q.sparkline } as GulfQuote;
      }),
    );

    const quotes: GulfQuote[] = results
      .map((r) => (r.status === 'fulfilled' ? r.value : null))
      .filter((q): q is GulfQuote => q !== null);

    return { quotes, rateLimited: false };
  } catch (err) {
    console.warn('[GulfQuotes] fetch failed:', (err as Error).message);
    return { quotes: [], rateLimited: false };
  }
}
