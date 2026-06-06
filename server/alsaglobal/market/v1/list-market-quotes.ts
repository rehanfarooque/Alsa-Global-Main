/**
 * AlsaGlobal: ListMarketQuotes — Yahoo Finance primary, Finnhub backup.
 *
 * Yahoo is the canonical source (free, covers stocks/indices/futures/forex/crypto).
 * Finnhub is only used when Yahoo returns 429/null AND key is configured.
 */

import type {
  ServerContext,
  ListMarketQuotesRequest,
  ListMarketQuotesResponse,
  MarketQuote,
} from '../../../../src/generated/server/alsaglobal/market/v1/service_server';
import { parseStringArray, fetchQuote, fetchFinnhubQuote, YAHOO_ONLY_SYMBOLS } from './_shared';

const DEFAULT_SYMBOLS = [
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA',
  'JPM', 'V', 'WMT', 'XOM', 'UNH', 'JNJ', 'PG', 'HD',
  'BAC', 'KO', 'DIS', 'NFLX', 'BA',
];

function isUsStock(sym: string): boolean {
  return /^[A-Z.]{1,5}$/.test(sym) && !YAHOO_ONLY_SYMBOLS.has(sym);
}

export async function listMarketQuotes(
  _ctx: ServerContext,
  req: ListMarketQuotesRequest,
): Promise<ListMarketQuotesResponse> {
  const parsedSymbols = parseStringArray(req.symbols);
  const symbolsToFetch = parsedSymbols.length > 0 ? parsedSymbols : DEFAULT_SYMBOLS;

  const finnhubKey = process.env.FINNHUB_API_KEY;

  const results = await Promise.allSettled(
    symbolsToFetch.map(async (sym) => {
      // Yahoo is primary (covers everything)
      const yq = await fetchQuote(sym);
      if (yq) return { sym, ...yq };

      // Finnhub backup for US stocks only
      if (finnhubKey && isUsStock(sym)) {
        const fh = await fetchFinnhubQuote(sym, finnhubKey);
        if (fh) return { sym, price: fh.price, change: fh.changePercent, sparkline: [] as number[] };
      }
      return null;
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
    finnhubSkipped: false,
    skipReason: '',
    rateLimited: false,
  };
}
