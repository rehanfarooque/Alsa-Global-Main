/**
 * AlsaGlobal: ListStablecoinMarkets — CoinGecko direct.
 * Stablecoin peg status and market data, fetched live from CoinGecko.
 */

import type {
  ServerContext,
  ListStablecoinMarketsRequest,
  ListStablecoinMarketsResponse,
} from '../../../../src/generated/server/alsaglobal/market/v1/service_server';
import { fetchCryptoMarkets } from './_shared';
import stablecoinConfig from '../../../../shared/stablecoins.json';

const EMPTY: ListStablecoinMarketsResponse = {
  timestamp: new Date().toISOString(),
  summary: {
    totalMarketCap: 0,
    totalVolume24h: 0,
    coinCount: 0,
    depeggedCount: 0,
    healthStatus: 'UNAVAILABLE',
  },
  stablecoins: [],
};

export async function listStablecoinMarkets(
  _ctx: ServerContext,
  _req: ListStablecoinMarketsRequest,
): Promise<ListStablecoinMarketsResponse> {
  try {
    const data = await fetchCryptoMarkets(stablecoinConfig.ids);
    if (!data.length) return EMPTY;

    const stablecoins = data.map((c) => {
      const price = c.current_price ?? 1;
      const deviation = Math.abs(price - 1);
      const depegged = deviation > 0.005; // >0.5% from $1
      return {
        id: c.id,
        symbol: (c.symbol ?? c.id).toUpperCase(),
        name: c.name ?? c.id,
        price,
        deviation: parseFloat((deviation * 100).toFixed(4)),
        pegStatus: depegged ? 'DEPEGGED' : 'PEGGED',
        marketCap: c.market_cap ?? 0,
        volume24h: c.total_volume ?? 0,
        change24h: c.price_change_percentage_24h ?? 0,
        change7d: c.price_change_percentage_7d_in_currency ?? 0,
        image: c.image ?? '',
      };
    });

    const totalMarketCap = stablecoins.reduce((s, c) => s + c.marketCap, 0);
    const totalVolume24h = stablecoins.reduce((s, c) => s + c.volume24h, 0);
    const depeggedCount = stablecoins.filter((c) => c.pegStatus === 'DEPEGGED').length;

    return {
      timestamp: new Date().toISOString(),
      summary: {
        totalMarketCap,
        totalVolume24h,
        coinCount: stablecoins.length,
        depeggedCount,
        healthStatus: depeggedCount > 0 ? 'DEGRADED' : 'HEALTHY',
      },
      stablecoins,
    };
  } catch (err) {
    console.warn('[StablecoinMarkets] CoinGecko fetch failed:', (err as Error).message);
    return EMPTY;
  }
}
