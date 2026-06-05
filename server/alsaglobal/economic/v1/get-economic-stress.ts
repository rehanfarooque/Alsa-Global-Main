/**
 * AlsaGlobal: GetEconomicStress — calculated from live market data.
 *
 * Financial Stress Index approximated from 5 components:
 *  1. VIX (equity volatility)    — weight 30%
 *  2. Gold vs equity ratio        — weight 20%  (safe haven demand)
 *  3. S&P 500 momentum (20d)     — weight 20%
 *  4. Oil volatility (WTI 5d)    — weight 15%
 *  5. USD strength (DXY 5d)      — weight 15%
 *
 * Score: 0-100 (100 = maximum stress). Label: LOW / ELEVATED / HIGH / CRISIS.
 */

import type {
  ServerContext,
  GetEconomicStressRequest,
  GetEconomicStressResponse,
  EconomicStressComponent,
} from '../../../../src/generated/server/alsaglobal/economic/v1/service_server';
import { fetchStooqQuote } from '../../market/v1/_shared';

function stressFromVix(vix: number): number {
  // VIX 10→0 stress, 40→100 stress, 80→100 (hard cap)
  return Math.min(100, Math.max(0, Math.round(((vix - 10) / 30) * 100)));
}

function stressFromGoldEquity(goldChange: number, spxChange: number): number {
  // Gold outperforming stocks = stress rising
  const gap = goldChange - spxChange;
  return Math.min(100, Math.max(0, Math.round(50 + gap * 8)));
}

function stressFromMomentum(spx20d: number): number {
  // Negative momentum = high stress
  return Math.min(100, Math.max(0, Math.round(50 - spx20d * 5)));
}

function stressFromOil(oilChange5d: number): number {
  // Large oil swings (either direction) = stress
  return Math.min(100, Math.max(0, Math.round(Math.abs(oilChange5d) * 5)));
}

function stressFromDxy(dxyChange5d: number): number {
  // Strong dollar usually = stress for EM / global liquidity
  return Math.min(100, Math.max(0, Math.round(50 + dxyChange5d * 10)));
}

function labelFromScore(score: number): string {
  if (score < 25) return 'LOW';
  if (score < 50) return 'ELEVATED';
  if (score < 75) return 'HIGH';
  return 'CRISIS';
}

export async function getEconomicStress(
  _ctx: ServerContext,
  _req: GetEconomicStressRequest,
): Promise<GetEconomicStressResponse> {
  const fallback: GetEconomicStressResponse = {
    compositeScore: 0,
    label: '',
    components: [],
    seededAt: '',
    unavailable: true,
  };

  try {
    // Stooq works for spot quotes (daily change), even without historical API key
    const [vixQ, spxQ, goldQ, oilQ] = await Promise.allSettled([
      fetchStooqQuote('^vix'),
      fetchStooqQuote('^spx'),
      fetchStooqQuote('gc.f'),
      fetchStooqQuote('cl.f'),
    ]);
    const dxyQ = { status: 'fulfilled' as const, value: null };

    const vix = vixQ.status === 'fulfilled' && vixQ.value ? vixQ.value.price : 20;
    const spxChange = spxQ.status === 'fulfilled' && spxQ.value ? spxQ.value.change : 0;
    const goldChange = goldQ.status === 'fulfilled' && goldQ.value ? goldQ.value.change : 0;
    const oilChange = oilQ.status === 'fulfilled' && oilQ.value ? oilQ.value.change : 0;

    const comps: Array<{ id: string; label: string; rawValue: number; score: number; weight: number }> = [
      { id: 'vix',          label: 'Equity Volatility (VIX)',   rawValue: vix,       score: stressFromVix(vix),               weight: 0.30 },
      { id: 'goldEquity',   label: 'Safe Haven Demand',          rawValue: goldChange, score: stressFromGoldEquity(goldChange, spxChange), weight: 0.20 },
      { id: 'spxMomentum',  label: 'S&P 500 Momentum',           rawValue: spxChange, score: stressFromMomentum(spxChange),    weight: 0.20 },
      { id: 'oilVol',       label: 'Oil Volatility (WTI)',       rawValue: oilChange, score: stressFromOil(oilChange),         weight: 0.15 },
      { id: 'dxyStrength',  label: 'USD Strength (DXY)',         rawValue: 0, score: 50, weight: 0.15 },
    ];

    const compositeScore = Math.round(
      comps.reduce((acc, c) => acc + c.score * c.weight, 0),
    );

    const components: EconomicStressComponent[] = comps.map((c) => ({
      id: c.id,
      label: c.label,
      rawValue: c.rawValue,
      score: c.score,
      weight: c.weight,
      missing: false,
    }));

    return {
      compositeScore,
      label: labelFromScore(compositeScore),
      components,
      seededAt: new Date().toISOString(),
      unavailable: false,
    };
  } catch (err) {
    console.warn('[EconomicStress] calculation failed:', (err as Error).message);
    return fallback;
  }
}
