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
import { fetchStooqQuote } from './_shared';

// Stooq symbols that reliably return data for GCC / oil-region assets.
// type: 'index' | 'currency' | 'commodity'
const GULF_ASSETS: Array<Omit<GulfQuote, 'price' | 'change' | 'sparkline'> & { stooqSymbol: string }> = [
  // Saudi Arabia direct index
  { symbol: '^TASI',   stooqSymbol: '^tasi',  name: 'Saudi Tadawul (TASI)',   flag: '🇸🇦', country: 'Saudi Arabia', type: 'index'     },
  // US-listed GCC ETFs (iShares MSCI series)
  { symbol: 'UAE',     stooqSymbol: 'uae.us', name: 'UAE Market (iShares)',   flag: '🇦🇪', country: 'UAE',          type: 'index'     },
  { symbol: 'QAT',     stooqSymbol: 'qat.us', name: 'Qatar Market (iShares)', flag: '🇶🇦', country: 'Qatar',        type: 'index'     },
  { symbol: 'KWT',     stooqSymbol: 'kwt.us', name: 'Kuwait Market (iShares)',flag: '🇰🇼', country: 'Kuwait',       type: 'index'     },
  // Gulf-critical commodities
  { symbol: 'BZ=F',    stooqSymbol: 'cb.f',   name: 'Brent Crude Oil',        flag: '🛢️',  country: '',             type: 'commodity' },
  { symbol: 'CL=F',    stooqSymbol: 'cl.f',   name: 'WTI Crude Oil',          flag: '🛢️',  country: '',             type: 'commodity' },
  { symbol: 'GC=F',    stooqSymbol: 'gc.f',   name: 'Gold (Comex)',            flag: '🥇',  country: '',             type: 'commodity' },
];

export async function listGulfQuotes(
  _ctx: ServerContext,
  _req: ListGulfQuotesRequest,
): Promise<ListGulfQuotesResponse> {
  try {
    const results = await Promise.allSettled(
      GULF_ASSETS.map(async ({ stooqSymbol, ...meta }) => {
        const q = await fetchStooqQuote(stooqSymbol);
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
