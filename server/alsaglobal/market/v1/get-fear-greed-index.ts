/**
 * AlsaGlobal: GetFearGreedIndex — calculated from live market data.
 *
 * Composite score built from 4 readily-available signals:
 *   1. VIX (^VIX from Stooq)        — volatility / fear gauge
 *   2. S&P 500 momentum (^SPX)       — trend direction
 *   3. BTC 24h change                — crypto risk appetite
 *   4. Gold 24h change (GC=F)        — safe-haven demand
 *
 * Each signal is normalised to 0-100 and weighted equally.
 * Score: 0-24 = Extreme Fear, 25-44 = Fear, 45-55 = Neutral, 56-74 = Greed, 75-100 = Extreme Greed.
 */

import type {
  ServerContext,
  GetFearGreedIndexRequest,
  GetFearGreedIndexResponse,
} from '../../../../src/generated/server/alsaglobal/market/v1/service_server';
import { fetchYahooQuote, fetchCoinGeckoMarkets } from './_shared';

function scoreVix(vix: number): number {
  // VIX: low = greed, high = fear. Invert.
  // Typical range 10-40. Map: 40→0 (extreme fear), 10→100 (extreme greed).
  if (vix <= 10) return 100;
  if (vix >= 40) return 0;
  return Math.round(100 - ((vix - 10) / 30) * 100);
}

function scoreMomentum(change: number): number {
  // Daily S&P 500 change: -3% → 0, 0% → 50, +3% → 100
  const clamped = Math.max(-3, Math.min(3, change));
  return Math.round(50 + (clamped / 3) * 50);
}

function scoreCryptoRisk(btcChange: number): number {
  // BTC 24h: -10% → 0, 0% → 50, +10% → 100
  const clamped = Math.max(-10, Math.min(10, btcChange));
  return Math.round(50 + (clamped / 10) * 50);
}

function scoreGoldSafeHaven(goldChange: number): number {
  // Gold rising = fear (capital fleeing to safety). Invert.
  // +2% → 0 (fear), 0% → 50, -2% → 100 (greed)
  const clamped = Math.max(-2, Math.min(2, goldChange));
  return Math.round(50 - (clamped / 2) * 50);
}

function labelFromScore(score: number): string {
  if (score <= 24) return 'Extreme Fear';
  if (score <= 44) return 'Fear';
  if (score <= 55) return 'Neutral';
  if (score <= 74) return 'Greed';
  return 'Extreme Greed';
}

export async function getFearGreedIndex(
  _ctx: ServerContext,
  _req: GetFearGreedIndexRequest,
): Promise<GetFearGreedIndexResponse> {
  try {
    const [vixQ, spxQ, goldQ, btcData] = await Promise.allSettled([
      fetchYahooQuote('%5EVIX'),
      fetchYahooQuote('%5EGSPC'),
      fetchYahooQuote('GC=F'),
      fetchCoinGeckoMarkets(['bitcoin']),
    ]);

    const vix = vixQ.status === 'fulfilled' && vixQ.value ? vixQ.value.price : 20;
    const spxChange = spxQ.status === 'fulfilled' && spxQ.value ? spxQ.value.change : 0;
    const goldChange = goldQ.status === 'fulfilled' && goldQ.value ? goldQ.value.change : 0;
    const btcChange = btcData.status === 'fulfilled' && btcData.value?.[0]
      ? btcData.value[0]!.price_change_percentage_24h ?? 0
      : 0;

    const vixScore = scoreVix(vix);
    const momentumScore = scoreMomentum(spxChange);
    const cryptoScore = scoreCryptoRisk(btcChange);
    const goldScore = scoreGoldSafeHaven(goldChange);

    const composite = Math.round((vixScore + momentumScore + cryptoScore + goldScore) / 4);
    const label = labelFromScore(composite);

    const makeCat = (score: number) => ({
      score,
      weight: 0.25,
      contribution: score * 0.25,
      degraded: false,
      inputsJson: '{}',
    });

    return {
      compositeScore: composite,
      compositeLabel: label,
      previousScore: composite,
      seededAt: new Date().toISOString(),
      sentiment: makeCat(cryptoScore),
      volatility: makeCat(vixScore),
      positioning: makeCat(momentumScore),
      trend: makeCat(momentumScore),
      breadth: makeCat(momentumScore),
      momentum: makeCat(momentumScore),
      liquidity: makeCat(50),
      credit: makeCat(50),
      macro: makeCat(goldScore),
      crossAsset: makeCat(Math.round((vixScore + cryptoScore) / 2)),
      vix,
      hySpread: 0,
      yield10y: 0,
      putCallRatio: 0,
      pctAbove200d: 0,
      cnnFearGreed: composite,
      cnnLabel: label,
      aaiiBull: 0,
      aaiiBear: 0,
      fedRate: '',
      fsiValue: Math.max(0, (vix - 15) / 15),
      fsiLabel: vix < 18 ? 'Low Stress' : vix < 22 ? 'Moderate Stress' : vix < 30 ? 'Elevated Stress' : 'Severe Stress',
      hygPrice: 0,
      tltPrice: 0,
      sectorPerformance: [],
      unavailable: false,
    };
  } catch (err) {
    console.warn('[FearGreed] calculation failed:', (err as Error).message);
    return { compositeScore: 0, compositeLabel: '', unavailable: true } as GetFearGreedIndexResponse;
  }
}
