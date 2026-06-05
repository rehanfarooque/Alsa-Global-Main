/**
 * AlsaGlobal: ListAiTokens — CoinGecko direct.
 * AI-sector tokens from ai-tokens.json, fetched live via CoinGecko.
 */

import type {
  ServerContext,
  ListAiTokensRequest,
  ListAiTokensResponse,
  CryptoQuote,
} from '../../../../src/generated/server/alsaglobal/market/v1/service_server';
import { fetchCryptoMarkets } from './_shared';
import aiTokenConfig from '../../../../shared/ai-tokens.json';

const META = aiTokenConfig.meta as Record<string, { name: string; symbol: string }>;

export async function listAiTokens(
  _ctx: ServerContext,
  _req: ListAiTokensRequest,
): Promise<ListAiTokensResponse> {
  try {
    const data = await fetchCryptoMarkets(aiTokenConfig.ids);
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
    console.warn('[AiTokens] CoinGecko fetch failed:', (err as Error).message);
    return { tokens: [] };
  }
}
