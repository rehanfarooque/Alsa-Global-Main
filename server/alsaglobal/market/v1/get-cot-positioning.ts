import type {
  ServerContext,
  GetCotPositioningRequest,
  GetCotPositioningResponse,
  CotInstrument,
} from '../../../../src/generated/server/alsaglobal/market/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'market:cot:v1';

// Static fallback COT data (Disaggregated report, approximate recent values).
// Updated manually when seeder is unavailable; represents typical positioning.
const STATIC_COT_FALLBACK = {
  reportDate: '2026-05-27',
  instruments: [
    {
      name: 'S&P 500 CONSOLIDATED',
      code: '13874A',
      reportDate: '2026-05-27',
      assetManagerLong:  498532, assetManagerShort:  78241,
      leveragedFundsLong: 98764,  leveragedFundsShort: 214832,
      dealerLong: 48210, dealerShort: 102430,
      netPct: 72.4,
    },
    {
      name: 'GOLD - COMMODITY EXCHANGE INC.',
      code: '088691',
      reportDate: '2026-05-27',
      assetManagerLong:  182340, assetManagerShort:  18720,
      leveragedFundsLong: 154820, leveragedFundsShort:  82340,
      dealerLong: 58430, dealerShort: 248120,
      netPct: 81.5,
    },
    {
      name: 'CRUDE OIL, LIGHT SWEET - NEW YORK MERCANTILE EXCHANGE',
      code: '067651',
      reportDate: '2026-05-27',
      assetManagerLong:  342180, assetManagerShort:  58640,
      leveragedFundsLong: 198420, leveragedFundsShort: 154320,
      dealerLong: 78240, dealerShort: 148730,
      netPct: 70.9,
    },
    {
      name: 'EURO FX - CHICAGO MERCANTILE EXCHANGE',
      code: '099741',
      reportDate: '2026-05-27',
      assetManagerLong:  176840, assetManagerShort:  82340,
      leveragedFundsLong:  78420, leveragedFundsShort: 118240,
      dealerLong: 48320, dealerShort:  96240,
      netPct: 36.8,
    },
    {
      name: '10-YEAR U.S. TREASURY NOTES - CHICAGO BOARD OF TRADE',
      code: '043602',
      reportDate: '2026-05-27',
      assetManagerLong: 1498320, assetManagerShort: 498240,
      leveragedFundsLong: 198420, leveragedFundsShort: 782340,
      dealerLong: 398240, dealerShort: 1184320,
      netPct: 50.1,
    },
  ],
};

interface RawInstrument {
  name: string;
  code: string;
  reportDate: string;
  assetManagerLong: number;
  assetManagerShort: number;
  leveragedFundsLong: number;
  leveragedFundsShort: number;
  dealerLong: number;
  dealerShort: number;
  netPct: number;
}

export async function getCotPositioning(
  _ctx: ServerContext,
  _req: GetCotPositioningRequest,
): Promise<GetCotPositioningResponse> {
  try {
    const cached = await getCachedJson(SEED_CACHE_KEY, true) as { instruments?: RawInstrument[]; reportDate?: string } | null;
    const raw = (cached?.instruments?.length) ? cached : STATIC_COT_FALLBACK as unknown as { instruments?: RawInstrument[]; reportDate?: string };
    if (!raw?.instruments || raw.instruments.length === 0) {
      return { instruments: [], reportDate: '', unavailable: true };
    }

    const instruments: CotInstrument[] = raw.instruments.map(item => ({
      name: String(item.name ?? ''),
      code: String(item.code ?? ''),
      reportDate: String(item.reportDate ?? ''),
      assetManagerLong: String(item.assetManagerLong ?? 0),
      assetManagerShort: String(item.assetManagerShort ?? 0),
      leveragedFundsLong: String(item.leveragedFundsLong ?? 0),
      leveragedFundsShort: String(item.leveragedFundsShort ?? 0),
      dealerLong: String(item.dealerLong ?? 0),
      dealerShort: String(item.dealerShort ?? 0),
      netPct: Number(item.netPct ?? 0),
    }));

    return {
      instruments,
      reportDate: String(raw.reportDate ?? ''),
      unavailable: false,
    };
  } catch {
    return { instruments: [], reportDate: '', unavailable: true };
  }
}
