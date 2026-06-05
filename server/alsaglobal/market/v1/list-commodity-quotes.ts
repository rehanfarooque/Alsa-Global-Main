/**
 * AlsaGlobal: ListCommodityQuotes — Yahoo Finance direct.
 * Yahoo futures symbols end in =F: GC=F (gold), CL=F (crude), NG=F (natural gas), etc.
 */

import type {
  ServerContext,
  ListCommodityQuotesRequest,
  ListCommodityQuotesResponse,
  CommodityQuote,
} from '../../../../src/generated/server/alsaglobal/market/v1/service_server';
import { parseStringArray, fetchQuote } from './_shared';

// Symbol → friendly display name + Yahoo symbol.
const COMMODITY_MAP: Record<string, { yahooSym: string; name: string; display: string }> = {
  GOLD:       { yahooSym: 'GC=F', name: 'Gold',        display: 'Gold (Spot)' },
  SILVER:     { yahooSym: 'SI=F', name: 'Silver',      display: 'Silver (Spot)' },
  COPPER:     { yahooSym: 'HG=F', name: 'Copper',      display: 'Copper' },
  PLATINUM:   { yahooSym: 'PL=F', name: 'Platinum',    display: 'Platinum' },
  PALLADIUM:  { yahooSym: 'PA=F', name: 'Palladium',   display: 'Palladium' },
  OIL_WTI:    { yahooSym: 'CL=F', name: 'WTI Crude',   display: 'Oil (WTI)' },
  OIL_BRENT:  { yahooSym: 'cb.f', name: 'Brent Crude', display: 'Oil (Brent)' },
  NATGAS:     { yahooSym: 'NG=F', name: 'Natural Gas', display: 'Natural Gas' },
  GASOLINE:   { yahooSym: 'RB=F', name: 'Gasoline',    display: 'Gasoline (RBOB)' },
  HEATING_OIL:{ yahooSym: 'HO=F', name: 'Heating Oil', display: 'Heating Oil' },
  CORN:       { yahooSym: 'ZC=F', name: 'Corn',        display: 'Corn' },
  WHEAT:      { yahooSym: 'ZW=F', name: 'Wheat',       display: 'Wheat' },
  SOYBEAN:    { yahooSym: 'ZS=F', name: 'Soybeans',    display: 'Soybeans' },
  COFFEE:     { yahooSym: 'KC=F', name: 'Coffee',      display: 'Coffee' },
  SUGAR:      { yahooSym: 'SB=F', name: 'Sugar',       display: 'Sugar' },
  COCOA:      { yahooSym: 'CC=F', name: 'Cocoa',       display: 'Cocoa' },
};

export async function listCommodityQuotes(
  _ctx: ServerContext,
  req: ListCommodityQuotesRequest,
): Promise<ListCommodityQuotesResponse> {
  const requested = parseStringArray(req.symbols);
  const symbols = requested.length > 0 ? requested : Object.keys(COMMODITY_MAP);

  const results = await Promise.allSettled(
    symbols.map(async (sym) => {
      // Accept either our friendly key (GOLD) or a raw Yahoo symbol (GC=F).
      const mapping = COMMODITY_MAP[sym.toUpperCase()];
      const yahooSym = mapping?.yahooSym ?? sym;
      const q = await fetchQuote(yahooSym);
      if (!q) return null;
      return {
        symbol: mapping ? sym.toUpperCase() : sym,
        name: mapping?.name ?? sym,
        display: mapping?.display ?? sym,
        price: q.price,
        change: q.change,
        sparkline: q.sparkline,
      };
    }),
  );

  const quotes: CommodityQuote[] = results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((q): q is CommodityQuote => q !== null);

  return { quotes };
}
