/**
 * AlsaGlobal: GetMacroSignals — FRED API + CoinGecko.
 *
 * Signals:
 *  - flowStructure: BTC vs NASDAQ 5-day returns (NASDAQ via FRED NASDAQCOM)
 *  - macroRegime:   NASDAQ vs SPX 20-day ROC (risk-on vs risk-off)
 *  - technicalTrend: BTC price vs 200d SMA (CoinGecko 1y)
 *  - priceMomentum: BTC 30d change
 *  - fearGreed:     VIX-based score (FRED VIXCLS)
 */

import type {
  ServerContext,
  GetMacroSignalsRequest,
  GetMacroSignalsResponse,
} from '../../../../src/generated/server/alsaglobal/economic/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';
import { fetchCoinGeckoMarkets } from '../../market/v1/_shared';

const FRED_TIMEOUT_MS = 12_000;

async function fetchFredHistory(seriesId: string, apiKey: string, days: number): Promise<number[]> {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&observation_start=${startDate}&frequency=d&api_key=${encodeURIComponent(apiKey)}&file_type=json`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(FRED_TIMEOUT_MS),
    });
    if (!resp.ok) return [];
    const json = await resp.json() as { observations?: Array<{ value: string }> };
    return (json.observations ?? [])
      .filter((o) => o.value !== '.' && o.value !== '')
      .map((o) => parseFloat(o.value))
      .filter((v) => Number.isFinite(v) && v > 0);
  } catch {
    return [];
  }
}

function roc(prices: number[], period: number): number {
  if (prices.length < period + 1) return 0;
  const latest = prices[prices.length - 1]!;
  const past = prices[prices.length - 1 - period]!;
  return past > 0 ? ((latest - past) / past) * 100 : 0;
}

function sma(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1] ?? 0;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function verdict(bullish: number, total: number): string {
  const ratio = bullish / total;
  if (ratio >= 0.7) return 'RISK_ON';
  if (ratio >= 0.5) return 'NEUTRAL';
  return 'RISK_OFF';
}

function statusStr(cond: boolean): string {
  return cond ? 'BULLISH' : 'BEARISH';
}

export async function getMacroSignals(
  _ctx: ServerContext,
  _req: GetMacroSignalsRequest,
): Promise<GetMacroSignalsResponse> {
  const FALLBACK: GetMacroSignalsResponse = {
    timestamp: new Date().toISOString(),
    verdict: 'UNKNOWN',
    bullishCount: 0,
    totalCount: 0,
    signals: {
      liquidity:     { status: 'UNKNOWN', sparkline: [] },
      flowStructure: { status: 'UNKNOWN' },
      macroRegime:   { status: 'UNKNOWN' },
      technicalTrend:{ status: 'UNKNOWN', sparkline: [] },
      hashRate:      { status: 'UNKNOWN' },
      priceMomentum: { status: 'UNKNOWN' },
      fearGreed:     { status: 'UNKNOWN', history: [] },
    },
    meta: { qqqSparkline: [] },
    unavailable: true,
  };

  const fredKey = process.env.FRED_API_KEY;
  if (!fredKey) {
    console.warn('[MacroSignals] FRED_API_KEY not set');
    return FALLBACK;
  }

  try {
    const [spxPrices, nasdaqPrices, vixPrices, btcData] = await Promise.all([
      fetchFredHistory('SP500', fredKey, 280),
      fetchFredHistory('NASDAQCOM', fredKey, 40),
      fetchFredHistory('VIXCLS', fredKey, 30),
      fetchCoinGeckoMarkets(['bitcoin']).catch(() => null),
    ]);

    const btcPriceNow = btcData?.[0]?.current_price ?? 0;
    const btcChange30d = btcData?.[0]?.price_change_percentage_7d_in_currency ?? 0;
    const btcSparkline = btcData?.[0]?.sparkline_in_7d?.price ?? [];

    if (!spxPrices.length) return FALLBACK;

    const spxSma200 = sma(spxPrices, 200);
    const spxNow = spxPrices[spxPrices.length - 1]!;
    const isBullTrend = spxSma200 > 0 && spxNow > spxSma200;

    const nasdaqRoc20 = roc(nasdaqPrices, 20);
    const spxRoc20 = roc(spxPrices.slice(-30), 20);
    const isRiskOn = nasdaqRoc20 > spxRoc20; // NASDAQ outperforming = risk-on

    const vixNow = vixPrices.length ? vixPrices[vixPrices.length - 1]! : 20;
    const isVolLow = vixNow < 20;

    const isMomentumPositive = btcChange30d > 0;
    const isBtcAboveSma200 = btcSparkline.length > 0 && btcPriceNow > sma(btcSparkline, Math.min(200, btcSparkline.length));

    let bullishCount = 0;
    if (isBullTrend) bullishCount++;
    if (isRiskOn) bullishCount++;
    if (isVolLow) bullishCount++;
    if (isMomentumPositive) bullishCount++;
    if (isBtcAboveSma200) bullishCount++;
    const totalCount = 5;

    const fgHistory = vixPrices.slice(-14).map((v, i) => {
      const score = Math.max(0, Math.min(100, Math.round(100 - ((v - 10) / 30) * 100)));
      return { date: new Date(Date.now() - (14 - i) * 86400000).toISOString().split('T')[0]!, score };
    });

    const fgNow = Math.round(100 - ((vixNow - 10) / 30) * 100);

    return {
      timestamp: new Date().toISOString(),
      verdict: verdict(bullishCount, totalCount),
      bullishCount,
      totalCount,
      signals: {
        liquidity: { status: isVolLow ? 'ABUNDANT' : 'TIGHT', value: vixNow, sparkline: vixPrices.slice(-14) },
        flowStructure: {
          status: statusStr(isRiskOn),
          btcReturn5: roc(btcSparkline, 5),
          qqqReturn5: nasdaqRoc20,
        },
        macroRegime: {
          status: statusStr(isBullTrend),
          qqqRoc20: nasdaqRoc20,
          xlpRoc20: spxRoc20,
        },
        technicalTrend: {
          status: statusStr(isBullTrend),
          btcPrice: btcPriceNow,
          sma200: spxSma200,
          sparkline: spxPrices.slice(-30),
        },
        hashRate: { status: 'UNKNOWN' },
        priceMomentum: {
          status: statusStr(isMomentumPositive),
          roc30d: btcChange30d,
          btcPrice: btcPriceNow,
        },
        fearGreed: {
          status: fgNow >= 50 ? 'GREEDY' : 'FEARFUL',
          score: fgNow,
          history: fgHistory,
        },
      },
      meta: { qqqSparkline: nasdaqPrices.slice(-14) },
      unavailable: false,
    };
  } catch (err) {
    console.warn('[MacroSignals] calculation failed:', (err as Error).message);
    return FALLBACK;
  }
}
