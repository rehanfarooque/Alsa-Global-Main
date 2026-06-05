/**
 * AlsaGlobal: ListMarketQuotes — Yahoo Finance direct.
 *
 * Original codebase reads from a Redis bootstrap cache populated by an
 * external Railway cron. AlsaGlobal self-hosts: hit Yahoo Finance directly.
 * Yahoo covers stocks, ETFs, indices, futures, and crypto in one API.
 */

import type {
  ServerContext,
  ListMarketQuotesRequest,
  ListMarketQuotesResponse,
  MarketQuote,
} from '../../../../src/generated/server/alsaglobal/market/v1/service_server';
import { parseStringArray, fetchQuote } from './_shared';

// Default basket: top 20 US stocks by market cap. Caller can override
// via `symbols`. Use Yahoo symbols (^GSPC for indices, GC=F for futures).
const DEFAULT_SYMBOLS = [
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA',
  'JPM', 'V', 'WMT', 'XOM', 'UNH', 'JNJ', 'PG', 'HD',
  'BAC', 'KO', 'DIS', 'NFLX', 'BA',
];

export async function listMarketQuotes(
  _ctx: ServerContext,
  req: ListMarketQuotesRequest,
): Promise<ListMarketQuotesResponse> {
  const parsedSymbols = parseStringArray(req.symbols);
  const symbolsToFetch = parsedSymbols.length > 0 ? parsedSymbols : DEFAULT_SYMBOLS;

  const results = await Promise.allSettled(
    symbolsToFetch.map(async (sym) => {
      const q = await fetchQuote(sym);
      return q ? { sym, ...q } : null;
    }),
  );

  const quotes: MarketQuote[] = results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((q): q is { sym: string; price: number; change: number; sparkline: number[] } => q !== null)
    .map((q) => ({
      symbol: q.sym,
      name: q.sym,
      display: q.sym,
      price: q.price,
      change: q.change,
      sparkline: q.sparkline,
    }));

  return {
    quotes,
    finnhubSkipped: true,
    skipReason: 'AlsaGlobal uses Yahoo Finance instead',
    rateLimited: false,
  };
}
