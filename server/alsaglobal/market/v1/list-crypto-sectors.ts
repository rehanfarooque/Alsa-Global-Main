/**
 * AlsaGlobal: ListCryptoSectors — CoinGecko direct.
 * Computes average 24h change per sector from crypto-sectors.json token lists.
 */

import type {
  ServerContext,
  ListCryptoSectorsRequest,
  ListCryptoSectorsResponse,
} from '../../../../src/generated/server/alsaglobal/market/v1/service_server';
import { fetchCryptoMarkets } from './_shared';
import cryptoSectors from '../../../../shared/crypto-sectors.json';

export async function listCryptoSectors(
  _ctx: ServerContext,
  _req: ListCryptoSectorsRequest,
): Promise<ListCryptoSectorsResponse> {
  try {
    const allIds = [...new Set(cryptoSectors.sectors.flatMap((s) => s.tokens))];
    const data = await fetchCryptoMarkets(allIds);
    const priceMap = new Map(data.map((c) => [c.id, c.price_change_percentage_24h ?? 0]));

    const sectors = cryptoSectors.sectors.map((s) => {
      const changes = s.tokens.map((id) => priceMap.get(id) ?? 0).filter((v) => v !== 0);
      const avg = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
      return { id: s.id, name: s.name, change: parseFloat(avg.toFixed(2)) };
    });

    return { sectors };
  } catch (err) {
    console.warn('[CryptoSectors] CoinGecko fetch failed:', (err as Error).message);
    return { sectors: [] };
  }
}
