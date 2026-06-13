/**
 * AlsaGlobal: GetSectorSummary — live sector ETF performance.
 * Uses SPDR sector ETFs (XLK, XLF, etc.) as proxies for US sector performance.
 *
 * Goes through the unified fetchQuote cascade (Yahoo → free fallbacks →
 * Stooq) rather than Stooq alone, so it works from data-center / VPS IPs
 * where Stooq's TCP connection hangs.
 */

import type {
  ServerContext,
  GetSectorSummaryRequest,
  GetSectorSummaryResponse,
  SectorPerformance,
} from '../../../../src/generated/server/alsaglobal/market/v1/service_server';
import { fetchQuote } from './_shared';

const SECTOR_ETFS: Array<{ symbol: string; name: string }> = [
  { symbol: 'XLK', name: 'Technology' },
  { symbol: 'XLF', name: 'Financials' },
  { symbol: 'XLV', name: 'Healthcare' },
  { symbol: 'XLC', name: 'Communication Services' },
  { symbol: 'XLY', name: 'Consumer Discretionary' },
  { symbol: 'XLI', name: 'Industrials' },
  { symbol: 'XLP', name: 'Consumer Staples' },
  { symbol: 'XLE', name: 'Energy' },
  { symbol: 'XLU', name: 'Utilities' },
  { symbol: 'XLRE', name: 'Real Estate' },
  { symbol: 'XLB', name: 'Materials' },
];

export async function getSectorSummary(
  _ctx: ServerContext,
  _req: GetSectorSummaryRequest,
): Promise<GetSectorSummaryResponse> {
  try {
    const results = await Promise.allSettled(
      SECTOR_ETFS.map(async (s) => {
        const q = await fetchQuote(s.symbol);
        return q ? { symbol: s.symbol, name: s.name, change: q.change } : null;
      }),
    );

    const sectors: SectorPerformance[] = results
      .map((r) => (r.status === 'fulfilled' ? r.value : null))
      .filter((s): s is SectorPerformance => s !== null);

    return { sectors };
  } catch (err) {
    console.warn('[SectorSummary] fetch failed:', (err as Error).message);
    return { sectors: [] };
  }
}
