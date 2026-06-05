/**
 * AlsaGlobal: ListDefiTokens — CoinGecko direct.
 * DeFi-sector tokens from defi-tokens.json, fetched live via CoinGecko.
 */

import type {
  ServerContext,
  ListDefiTokensRequest,
  ListDefiTokensResponse,
  CryptoQuote,
} from '../../../../src/generated/server/alsaglobal/market/v1/service_server';
import { fetchCryptoMarkets } from './_shared';
import defiTokenConfig from '../../../../shared/defi-tokens.json';

const META = defiTokenConfig.meta as Record<string, { name: string; symbol: string }>;

export async function listDefiTokens(
  _ctx: ServerContext,
  _req: ListDefiTokensRequest,
): Promise<ListDefiTokensResponse> {
  try {
    const data = await fetchCryptoMarkets(defiTokenConfig.ids);
    const tokens: CryptoQuote[] = data.map((c) => ({
      name: c.name ?? META[c.id]?.name ?? c.id,
      symbol: (c.symbol ?? META[c.id]?.symbol ?? c.id).toUpperCase(),
      price: c.current_price ?? 0,
      change: c.price_change_percentage_24h ?? 0,
      change7d: c.price_change_percentage_7d_in_currency ?? 0,
      sparkline: c.sparkline_in_7d?.price ?? [],
    }));
    return { tokens };
  } catch (err) {
    console.warn('[DefiTokens] CoinGecko fetch failed:', (err as Error).message);
    return { tokens: [] };
  }
}
