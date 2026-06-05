/**
 * AlsaGlobal: ListCryptoQuotes — CoinGecko direct.
 * CoinGecko's /coins/markets endpoint is free, batched, and returns
 * 24h change + 7-day sparkline in one call. No key required.
 * Default: top-50 by market cap, covering major + DeFi + AI + meme coins.
 */

import type {
  ServerContext,
  ListCryptoQuotesRequest,
  ListCryptoQuotesResponse,
  CryptoQuote,
} from '../../../../src/generated/server/alsaglobal/market/v1/service_server';
import { CRYPTO_META, parseStringArray, fetchCryptoMarkets } from './_shared';

// Top-50 by market cap covering major, DeFi, AI, meme, and layer-2 tokens.
const DEFAULT_IDS = [
  // Top layer 1
  'bitcoin', 'ethereum', 'tether', 'binancecoin', 'solana',
  'ripple', 'usd-coin', 'cardano', 'dogecoin', 'avalanche-2',
  'tron', 'chainlink', 'polkadot', 'shiba-inu', 'stellar',
  'wrapped-bitcoin', 'cosmos', 'litecoin', 'uniswap', 'near',
  // Layer 2 & scaling
  'matic-network', 'arbitrum', 'optimism', 'immutable-x', 'starknet',
  // DeFi
  'aave', 'maker', 'lido-dao', 'curve-dao-token', 'hyperliquid',
  // AI tokens
  'bittensor', 'render-token', 'fetch-ai', 'akash-network', 'virtual-protocol',
  // Meme & culture
  'pepe', 'floki', 'bonk', 'dogwifhat',
  // Stablecoins & other
  'dai', 'ethena-usde', 'first-digital-usd',
  // More major
  'internet-computer', 'aptos', 'sui',
  'hedera-hashgraph', 'vechain', 'filecoin', 'injective-protocol',
];

export async function listCryptoQuotes(
  _ctx: ServerContext,
  req: ListCryptoQuotesRequest,
): Promise<ListCryptoQuotesResponse> {
  const parsedIds = parseStringArray(req.ids);
  const ids = parsedIds.length > 0 ? parsedIds : DEFAULT_IDS;

  try {
    // CoinGecko accepts max 250 per request; split if needed
    const BATCH = 200;
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));

    const allData = (await Promise.all(batches.map((b) => fetchCryptoMarkets(b)))).flat();

    const quotes: CryptoQuote[] = allData.map((c) => ({
      name: c.name ?? CRYPTO_META[c.id]?.name ?? c.id,
      symbol: (c.symbol ?? CRYPTO_META[c.id]?.symbol ?? c.id).toUpperCase(),
      price: c.current_price ?? 0,
      change: c.price_change_percentage_24h ?? 0,
      sparkline: c.sparkline_in_7d?.price ?? [],
      change7d: c.price_change_percentage_7d_in_currency ?? 0,
    }));
    return { quotes };
  } catch (err) {
    console.warn('[CryptoQuotes] CoinGecko fetch failed:', (err as Error).message);
    return { quotes: [] };
  }
}
