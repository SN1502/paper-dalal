import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { scoreFundamentals } from '../src/strategies/fundamentals';
import { demeanedRanks, ols, percentiles, ranks, stdev } from '../src/strategies/math';
import {
  channel,
  computeScan,
  momentum12_1,
  regimeOf,
  residualStats,
  riskAdjustedMomentum,
  threeMaSignal,
  twoMaSignal,
  volatility,
  type CloseSeries,
} from '../src/strategies/scan';
import { ibs, knnForecast, pivotFrom, pivots } from '../src/strategies/single';
import type { Candle } from '../src/engine/types';

const DAY = 86_400_000;
const START = Date.UTC(2024, 9, 1, 3, 45); // 09:15 IST

/** Weekday timestamps, one per trading day. */
function calendar(n: number): number[] {
  const out: number[] = [];
  let t = START;
  while (out.length < n) {
    const wd = new Date(t + 330 * 60_000).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(t);
    t += DAY;
  }
  return out;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function gauss(r: () => number) {
  const u = Math.max(1e-12, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function seriesFromReturns(t: number[], rets: number[], p0 = 100): CloseSeries {
  const c = [p0];
  for (let i = 1; i < t.length; i++) c.push(c[i - 1] * (1 + rets[i]));
  return { t, c };
}

describe('math helpers', () => {
  it('ranks ties with their average and skips nulls', () => {
    assert.deepEqual(ranks([3, 1, null, 3, 2]), [3.5, 1, null, 3.5, 2]);
    assert.deepEqual(percentiles([10, 20, 30]), [0, 50, 100]);
    const d = demeanedRanks([5, 1, 3]);
    assert.deepEqual(d, [1, -1, 0]);
  });

  it('recovers alpha and beta with OLS', () => {
    const x = Array.from({ length: 50 }, (_, i) => Math.sin(i));
    const y = x.map((v) => 0.01 + 1.5 * v);
    const f = ols(y, x)!;
    assert.ok(Math.abs(f.beta - 1.5) < 1e-9);
    assert.ok(Math.abs(f.alpha - 0.01) < 1e-9);
    assert.ok(Math.abs(f.r2 - 1) < 1e-9);
  });
});

describe('§3.1 momentum, §3.4 volatility, §3.7 residual momentum', () => {
  it('computes R_cum = P(S)/P(S+T) − 1 with S = 21 and T = 252 trading days', () => {
    const c = Array.from({ length: 300 }, (_, i) => 100 + i);
    const L = 299;
    assert.equal(momentum12_1(c), c[L - 21] / c[L - 273] - 1);
    assert.equal(momentum12_1(c.slice(0, 273)), null, 'needs 13 months of bars');
    assert.ok((riskAdjustedMomentum(c) ?? 0) > 0);
  });

  it('measures annualised volatility', () => {
    const r = rng(1);
    const t = calendar(300);
    const calm = seriesFromReturns(t, t.map(() => 0.005 * gauss(r)));
    const wild = seriesFromReturns(t, t.map(() => 0.03 * gauss(r)));
    assert.ok(volatility(calm.c)! < volatility(wild.c)!);
    assert.ok(Math.abs(volatility(wild.c)! - 0.03 * Math.sqrt(252)) < 0.1);
  });

  it('finds a positive residual momentum when a stock beats its beta', () => {
    const r = rng(2);
    const t = calendar(500);
    const m = t.map(() => 0.01 * gauss(r));
    const market = seriesFromReturns(t, m);
    const stock = seriesFromReturns(t, m.map((x, i) => 1.2 * x + (i > 220 ? 0.002 : 0) + 0.004 * gauss(r)));
    const s = residualStats(stock.c, market.c);
    assert.ok(Math.abs((s.beta ?? 0) - 1.2) < 0.15, `beta ${s.beta}`);
    assert.ok((s.resMom ?? 0) > 0.2, `resMom ${s.resMom}`);
    assert.ok((s.r2 ?? 0) > 0.6);
    assert.ok((s.alpha ?? 0) > 0);
  });
});

describe('§3.11–3.15 single-stock rules', () => {
  it('reads moving-average alignments and channels', () => {
    const up = Array.from({ length: 60 }, (_, i) => 100 + i);
    assert.equal(twoMaSignal(up), 'up');
    assert.equal(threeMaSignal(up), 'up');
    const down = [...up].reverse();
    assert.equal(twoMaSignal(down), 'down');
    assert.equal(threeMaSignal(down), 'down');
    const ch = channel(down)!;
    assert.equal(ch.atFloor, true);
    assert.equal(ch.low, 100);
  });

  it('computes the pivot, resistance and support of eq. (325)–(327)', () => {
    const p = pivotFrom(110, 90, 100, 105);
    assert.equal(p.pivot, 100);
    assert.equal(p.resistance, 110);
    assert.equal(p.support, 90);
    assert.equal(p.bias, 'long');
  });

  it('computes daily and weekly pivots and IBS from candles', () => {
    const t = calendar(6);
    const candles: Candle[] = t.map((x, i) => ({ t: x, o: 100, h: 105 + i, l: 95 - i, c: 100 + i, v: 1000 }));
    const pv = pivots(candles, 103);
    assert.equal(pv.daily?.pivot, Math.round(((110 + 90 + 105) / 3) * 100) / 100);
    assert.ok(pv.weekly);
    assert.equal(ibs(candles), Math.round(((105 - 90) / (110 - 90)) * 1000) / 1000);
  });

  it('§3.17 KNN learns a repeating pattern and validates out of sample', () => {
    const t = calendar(420);
    const candles: Candle[] = t.map((x, i) => {
      const c = 100 * (1 + 0.08 * Math.sin((2 * Math.PI * i) / 40));
      return { t: x, o: c, h: c * 1.01, l: c * 0.99, c, v: 1000 + 200 * Math.cos((2 * Math.PI * i) / 40) };
    });
    const k = knnForecast(candles, 10)!;
    assert.ok(k.samples > 300);
    assert.equal(k.k, Math.floor(Math.sqrt(k.samples)));
    assert.ok(k.cvHitRate > 0.8, `hit rate ${k.cvHitRate}`);
    assert.ok((k.cvCorrelation ?? 0) > 0.7);
  });
});

describe('§3.6 multifactor scan, §4.1 sector rotation, §4.1.2 regime', () => {
  it('ranks a strong, steady stock in a leading sector at the top', () => {
    const r = rng(3);
    const t = calendar(480);
    const m = t.map(() => 0.004 + 0.008 * gauss(r));
    const bench = seriesFromReturns(t, m);
    const mk = (drift: number, noise: number) => seriesFromReturns(t, m.map((x) => x + drift + noise * gauss(r)));
    const history: Record<string, CloseSeries> = {
      'LEAD.NS': mk(0.0015, 0.004),
      'PEER.NS': mk(0.0008, 0.006),
      'LAG.NS': mk(-0.0015, 0.02),
      'LAG2.NS': mk(-0.001, 0.018),
      'MID.NS': mk(0, 0.01),
      'MID2.NS': mk(0.0002, 0.012),
    };
    const universe = [
      { symbol: 'LEAD.NS', tradingSymbol: 'LEAD', name: 'Lead', sector: 'Alpha' },
      { symbol: 'PEER.NS', tradingSymbol: 'PEER', name: 'Peer', sector: 'Alpha' },
      { symbol: 'LAG.NS', tradingSymbol: 'LAG', name: 'Lag', sector: 'Beta' },
      { symbol: 'LAG2.NS', tradingSymbol: 'LAG2', name: 'Lag 2', sector: 'Beta' },
      { symbol: 'MID.NS', tradingSymbol: 'MID', name: 'Mid', sector: 'Gamma' },
      { symbol: 'MID2.NS', tradingSymbol: 'MID2', name: 'Mid 2', sector: 'Gamma' },
      { symbol: 'NODATA.NS', tradingSymbol: 'NODATA', name: 'No data', sector: 'Gamma' },
    ];
    const scan = computeScan({ universe, history, benchmark: bench, computedAt: t[t.length - 1] })!;
    assert.equal(scan.universeSize, 7);
    assert.equal(scan.covered, 6);
    assert.equal(scan.stocks[0].tradingSymbol, 'LEAD');
    assert.equal(scan.stocks[0].decile, 10);
    assert.ok(scan.stocks[0].tags.includes('Top decile'));
    assert.equal(scan.sectors[0].sector, 'Alpha');
    assert.equal(scan.sectors[scan.sectors.length - 1].sector, 'Beta');
    assert.equal(scan.regime?.state, 'risk-on');
    // Cluster-demeaned reversal sums to zero within each sector.
    const alpha = scan.stocks.filter((s) => s.sector === 'Alpha').map((s) => s.rev5dDemeaned ?? 0);
    assert.ok(Math.abs(alpha[0] + alpha[1]) < 1e-3);
  });

  it('flags risk-off when the index is below its 100- and 200-day averages', () => {
    const c = [...Array.from({ length: 220 }, (_, i) => 100 + i), ...Array.from({ length: 60 }, (_, i) => 320 - 3 * i)];
    assert.equal(regimeOf(c)?.state, 'risk-off');
  });
});

describe('§3.2 SUE and §3.3 value', () => {
  it('computes SUE = (E − E′)/σ over the last 8 quarters of unexpected earnings', () => {
    const eps = [10, 10, 11, 11, 11, 12, 12, 13, 13, 14, 14, 17];
    const res = scoreFundamentals({ quarterlyEps: eps, bookValuePerShare: 200, price: 1000 });
    const ue = eps.slice(4).map((e, i) => e - eps[i]);
    const expected = ue[ue.length - 1] / stdev(ue);
    assert.equal(res.unexpectedQuarters, 8);
    assert.equal(res.sue, Math.round(expected * 100) / 100);
    assert.equal(res.bookToPrice, 0.2);
    assert.equal(res.trailingEps, 58);
    assert.equal(res.earningsYield, 0.058);
    assert.ok(['positive', 'strong positive'].includes(res.sueLabel));
  });

  it('refuses SUE with too few quarters', () => {
    const res = scoreFundamentals({ quarterlyEps: [1, 2, 3, 4, 5], bookValuePerShare: null, price: 100 });
    assert.equal(res.sue, null);
    assert.equal(res.sueLabel, 'unavailable');
  });
});
