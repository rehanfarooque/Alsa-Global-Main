/**
 * AlsaGlobal: ListOtherTokens — gaming, privacy, infra, meme, new L1s.
 * Data: CoinGecko primary → CoinPaprika fallback (full mappings in other-tokens.json).
 */

import type {
  ServerContext,
  ListOtherTokensRequest,
  ListOtherTokensResponse,
  CryptoQuote,
} from '../../../../src/generated/server/alsaglobal/market/v1/service_server';
import { fetchCryptoMarkets } from './_shared';
import otherTokenConfig from '../../../../shared/other-tokens.json';

export async function listOtherTokens(
  _ctx: ServerContext,
  _req: ListOtherTokensRequest,
): Promise<ListOtherTokensResponse> {
  try {
    const data = await fetchCryptoMarkets(otherTokenConfig.ids);
    const tokens: CryptoQuote[] = data.map((c) => ({
      name: c.name ?? c.id,
      symbol: (c.symbol ?? c.id).toUpperCase(),
      price: c.current_price ?? 0,
      change: c.price_change_percentage_24h ?? 0,
      change7d: c.price_change_percentage_7d_in_currency ?? 0,
      sparkline: c.sparkline_in_7d?.price ?? [],
    }));
    return { tokens };
  } catch (err) {
    console.warn('[OtherTokens] fetch failed:', (err as Error).message);
    return { tokens: [] };
  }
}
