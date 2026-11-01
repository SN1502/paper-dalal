/**
 * Cross-sectional strategy scan, following Kakushadze & Serur, "151 Trading Strategies"
 * (2018), adapted to a long-only NSE swing book on daily closes:
 *
 *  §3.1   price momentum: R_cum = P(S)/P(S+T) − 1 with T = 12 months, S = 1 month, plus the
 *         risk-adjusted mean/σ of monthly returns
 *  §3.4   low-volatility anomaly: σ of daily returns over 252 trading days
 *  §3.7   residual momentum: residuals of a market regression (Nifty 50 as the market factor),
 *         normalised as mean/σ over the 12-1 month formation window
 *  §3.6   multifactor portfolio: average of demeaned ranks across factors (eq. 276–277)
 *  §3.9.1 mean reversion, multiple clusters: 5-day log returns demeaned within the sector
 *  §3.11–3.13 one, two (10/30) and three (3/10/21) moving-average signals
 *  §3.15  Donchian channel (20 days)
 *  §4.1   sector momentum rotation on equal-weighted sector indices (6 and 12 months),
 *  §4.1.1 with a moving-average filter
 *  §4.1.2 dual momentum: broad index vs its 100/200-day averages decides risk-on/off
 *  §4.2–4.3 alpha and R² from a one-year market regression
 *
 * Everything is pure so it can be tested off-device.
 */
import { istDayKey } from '../lib/time';
import { demeanedRanks, mean, ols, percentiles, returns, round, sma, stdev } from './math';

export const MONTH = 21;
export const YEAR = 252;
const MOM_SKIP = MONTH; // S = 1 month
const MOM_FORMATION = 12 * MONTH; // T = 12 months
const VOL_LOOKBACK = YEAR;
const REVERSAL_DAYS = 5;
const CHANNEL_DAYS = 20;
const SECTOR_WINDOW = YEAR;

export interface CloseSeries {
  /** Epoch ms of each daily bar, oldest first. */
  t: number[];
  c: number[];
}

export interface UniverseMember {
  symbol: string;
  tradingSymbol: string;
  name: string;
  sector: string;
}

export interface ScanInput {
  universe: UniverseMember[];
  history: Record<string, CloseSeries | undefined>;
  /** Nifty 50 closes; the market factor and the dual-momentum benchmark. */
  benchmark: CloseSeries | null;
  computedAt: number;
}

export interface FactorPercentiles {
  momentum: number | null;
  residualMomentum: number | null;
  lowVol: number | null;
  sector: number | null;
  composite: number | null;
  /** High = the stock fell most against its sector over 5 days (a mean-reversion buy candidate). */
  reversal: number | null;
}

export interface StockSignal {
  symbol: string;
  tradingSymbol: string;
  name: string;
  sector: string;
  price: number;
  lastDay: string;
  bars: number;
  /** §3.1, as a fraction (0.25 = +25%). */
  mom12_1: number | null;
  momRiskAdj: number | null;
  /** §3.4, annualised. */
  vol: number | null;
  /** §3.7, mean/σ of residuals. */
  resMom: number | null;
  beta: number | null;
  /** §4.2, annualised intercept of the one-year regression. */
  alpha: number | null;
  /** §4.3; selectivity = 1 − R². */
  r2: number | null;
  ret1m: number | null;
  ret6m: number | null;
  /** §3.9.1, 5-day log return minus its sector's mean. */
  rev5dDemeaned: number | null;
  aboveSma50: boolean | null;
  aboveSma100: boolean | null;
  aboveSma200: boolean | null;
  /** §3.12: MA(10) vs MA(30). */
  ma2: 'up' | 'down' | null;
  /** §3.13: MA(3) > MA(10) > MA(21) is 'up', the reverse 'down'. */
  ma3: 'up' | 'down' | 'mixed' | null;
  channel: { high: number; low: number; position: number; atFloor: boolean; atCeiling: boolean } | null;
  pct: FactorPercentiles;
  composite: number | null;
  /** 1–10 by composite, 10 = top decile. */
  decile: number | null;
  tags: string[];
}

export interface SectorSignal {
  sector: string;
  members: number;
  ret6m: number | null;
  ret12m: number | null;
  /** §4.1.1 filter on the equal-weighted sector index. */
  aboveMa100: boolean | null;
  aboveMa200: boolean | null;
  rank: number;
}

export type RegimeState = 'risk-on' | 'mixed' | 'risk-off';

export interface Regime {
  state: RegimeState;
  close: number;
  sma100: number | null;
  sma200: number | null;
  ret6m: number | null;
  mom12_1: number | null;
}

export interface ScanResult {
  version: 1;
  computedAt: number;
  /** IST date of the latest bar used. */
  asOfDay: string;
  universeSize: number;
  covered: number;
  stocks: StockSignal[];
  sectors: SectorSignal[];
  regime: Regime | null;
}

/** Aligns a series to a master calendar of IST days, forward-filling gaps after the first bar. */
export function alignToCalendar(series: CloseSeries, days: string[]): (number | null)[] {
  const byDay = new Map<string, number>();
  for (let i = 0; i < series.t.length; i++) {
    const c = series.c[i];
    if (Number.isFinite(c) && c > 0) byDay.set(istDayKey(series.t[i]), c);
  }
  const out: (number | null)[] = [];
  let last: number | null = null;
  for (const d of days) {
    const v = byDay.get(d);
    if (v !== undefined) last = v;
    out.push(last);
  }
  return out;
}

/** The trailing run of non-null values (a stock that listed recently has nulls in front). */
function tail(values: (number | null)[]): number[] {
  let start = values.length;
  while (start > 0 && values[start - 1] !== null) start--;
  return values.slice(start) as number[];
}

/** §3.1 cumulative return R_cum = P(S)/P(S+T) − 1 on daily bars. */
export function momentum12_1(c: number[]): number | null {
  const L = c.length - 1;
  if (L - MOM_SKIP - MOM_FORMATION < 0) return null;
  return c[L - MOM_SKIP] / c[L - MOM_SKIP - MOM_FORMATION] - 1;
}

/** §3.1 risk-adjusted momentum: mean/σ of the 12 monthly returns in the formation window. */
export function riskAdjustedMomentum(c: number[]): number | null {
  const L = c.length - 1;
  if (L - MOM_SKIP - MOM_FORMATION < 0) return null;
  const monthly: number[] = [];
  for (let k = 1; k <= 12; k++) {
    const end = L - MONTH * k;
    const start = L - MONTH * (k + 1);
    monthly.push(c[end] / c[start] - 1);
  }
  const s = stdev(monthly);
  return s > 0 ? mean(monthly) / s : null;
}

/** §3.4 historical volatility of daily returns, annualised. */
export function volatility(c: number[], lookback = VOL_LOOKBACK): number | null {
  if (c.length < Math.min(lookback, 126) + 1) return null;
  const r = returns(c.slice(-Math.min(lookback, c.length - 1) - 1));
  const s = stdev(r);
  return Number.isFinite(s) ? s * Math.sqrt(YEAR) : null;
}

export interface ResidualStats {
  resMom: number | null;
  beta: number | null;
  alpha: number | null;
  r2: number | null;
}

/**
 * §3.7 residual momentum and §4.2–4.3 alpha/R².
 * `stock` and `market` are aligned closes of equal length (no nulls).
 */
export function residualStats(stock: number[], market: number[]): ResidualStats {
  const n = Math.min(stock.length, market.length);
  const rs = returns(stock.slice(-n));
  const rm = returns(market.slice(-n));
  const out: ResidualStats = { resMom: null, beta: null, alpha: null, r2: null };

  // Alpha rotation (§4.2) and R-squared (§4.3): one year of daily returns.
  if (rs.length >= YEAR) {
    const fit = ols(rs.slice(-YEAR), rm.slice(-YEAR));
    if (fit) {
      out.alpha = fit.alpha * YEAR;
      out.r2 = fit.r2;
    }
  }

  // Residual momentum (§3.7): estimate betas on data up to the skip month, then take the
  // residuals over the 12-month formation window and normalise them (eq. 280–282).
  const L = rs.length; // returns index: rs[j] is the return into close j+1
  const formEnd = L - MOM_SKIP;
  const formStart = formEnd - MOM_FORMATION;
  if (formStart >= 0) {
    const est = ols(rs.slice(0, formEnd), rm.slice(0, formEnd));
    if (est) {
      out.beta = est.beta;
      const eps: number[] = [];
      for (let j = formStart; j < formEnd; j++) eps.push(rs[j] - est.beta * rm[j]);
      const s = stdev(eps);
      if (s > 0) out.resMom = mean(eps) / s;
    }
  }
  return out;
}

/** §3.12 two moving averages, T' = 10 and T = 30. */
export function twoMaSignal(c: number[]): 'up' | 'down' | null {
  const fast = sma(c, 10);
  const slow = sma(c, 30);
  if (fast === null || slow === null) return null;
  return fast > slow ? 'up' : 'down';
}

/** §3.13 three moving averages, T1 = 3, T2 = 10, T3 = 21. */
export function threeMaSignal(c: number[]): 'up' | 'down' | 'mixed' | null {
  const a = sma(c, 3);
  const b = sma(c, 10);
  const d = sma(c, 21);
  if (a === null || b === null || d === null) return null;
  if (a > b && b > d) return 'up';
  if (a < b && b < d) return 'down';
  return 'mixed';
}

/** §3.15 Donchian channel on closes. */
export function channel(c: number[], days = CHANNEL_DAYS) {
  if (c.length < days) return null;
  const w = c.slice(-days);
  const high = Math.max(...w);
  const low = Math.min(...w);
  const p = c[c.length - 1];
  const position = high > low ? (p - low) / (high - low) : 0.5;
  // Within the bottom or top 10% of the channel; mutually exclusive even for narrow channels.
  return { high, low, position, atFloor: high > low && position <= 0.1, atCeiling: high > low && position >= 0.9 };
}

export function regimeOf(c: number[]): Regime | null {
  if (c.length < 101) return null;
  const close = c[c.length - 1];
  const s100 = sma(c, 100);
  const s200 = sma(c, 200);
  let state: RegimeState = 'mixed';
  if (s200 !== null && s100 !== null) {
    if (close > s200 && close > s100) state = 'risk-on';
    else if (close < s200 && close < s100) state = 'risk-off';
  } else if (s100 !== null) {
    state = close > s100 ? 'risk-on' : 'risk-off';
  }
  return {
    state,
    close,
    sma100: s100,
    sma200: s200,
    ret6m: c.length > 126 ? close / c[c.length - 1 - 126] - 1 : null,
    mom12_1: momentum12_1(c),
  };
}

interface Working {
  m: UniverseMember;
  aligned: (number | null)[];
  c: number[];
  sig: StockSignal;
  rev5: number | null;
}

export function computeScan(input: ScanInput): ScanResult | null {
  // Master calendar: the benchmark's trading days, or the longest stock history if it's missing.
  let calendarSeries = input.benchmark && input.benchmark.t.length > 0 ? input.benchmark : null;
  if (!calendarSeries) {
    for (const m of input.universe) {
      const h = input.history[m.symbol];
      if (h && (!calendarSeries || h.t.length > calendarSeries.t.length)) calendarSeries = h;
    }
  }
  if (!calendarSeries || calendarSeries.t.length < 60) return null;
  const days: string[] = [];
  for (const t of calendarSeries.t) {
    const d = istDayKey(t);
    if (days[days.length - 1] !== d) days.push(d);
  }
  const bench = input.benchmark ? tail(alignToCalendar(input.benchmark, days)) : null;

  const work: Working[] = [];
  for (const m of input.universe) {
    const h = input.history[m.symbol];
    if (!h || h.c.length < 60) continue;
    const aligned = alignToCalendar(h, days);
    const c = tail(aligned);
    if (c.length < 60) continue;
    const L = c.length - 1;
    const price = c[L];
    const res = bench && bench.length >= c.length ? residualStats(c, bench.slice(-c.length)) : null;
    const s50 = sma(c, 50);
    const s100 = sma(c, 100);
    const s200 = sma(c, 200);
    const sig: StockSignal = {
      symbol: m.symbol,
      tradingSymbol: m.tradingSymbol,
      name: m.name,
      sector: m.sector,
      price,
      lastDay: days[days.length - 1],
      bars: c.length,
      mom12_1: momentum12_1(c),
      momRiskAdj: riskAdjustedMomentum(c),
      vol: volatility(c),
      resMom: res?.resMom ?? null,
      beta: res?.beta ?? null,
      alpha: res?.alpha ?? null,
      r2: res?.r2 ?? null,
      ret1m: L >= MONTH ? price / c[L - MONTH] - 1 : null,
      ret6m: L >= 126 ? price / c[L - 126] - 1 : null,
      rev5dDemeaned: null,
      aboveSma50: s50 !== null ? price > s50 : null,
      aboveSma100: s100 !== null ? price > s100 : null,
      aboveSma200: s200 !== null ? price > s200 : null,
      ma2: twoMaSignal(c),
      ma3: threeMaSignal(c),
      channel: channel(c),
      pct: { momentum: null, residualMomentum: null, lowVol: null, sector: null, composite: null, reversal: null },
      composite: null,
      decile: null,
      tags: [],
    };
    const rev5 = L >= REVERSAL_DAYS ? Math.log(price / c[L - REVERSAL_DAYS]) : null;
    work.push({ m, aligned, c, sig, rev5 });
  }
  if (work.length === 0) return null;

  // §4.1 sector momentum on equal-weighted sector indices, with the §4.1.1 MA filter.
  const bySector = new Map<string, Working[]>();
  for (const w of work) {
    const list = bySector.get(w.m.sector) ?? [];
    list.push(w);
    bySector.set(w.m.sector, list);
  }
  const sectorRows: Omit<SectorSignal, 'rank'>[] = [];
  const nDays = days.length;
  const win = Math.min(SECTOR_WINDOW, nDays - 1);
  for (const [sector, members] of bySector) {
    const usable = members.filter((w) => w.aligned[nDays - 1 - win] !== null);
    if (usable.length === 0) continue;
    const index: number[] = [];
    for (let i = nDays - 1 - win; i < nDays; i++) {
      let sum = 0;
      for (const w of usable) sum += (w.aligned[i] as number) / (w.aligned[nDays - 1 - win] as number);
      index.push(sum / usable.length);
    }
    const last = index[index.length - 1];
    const ma100 = sma(index, 100);
    const ma200 = sma(index, 200);
    sectorRows.push({
      sector,
      members: usable.length,
      ret6m: index.length > 126 ? last / index[index.length - 1 - 126] - 1 : null,
      ret12m: index.length > YEAR ? last / index[0] - 1 : null,
      aboveMa100: ma100 !== null ? last > ma100 : null,
      aboveMa200: ma200 !== null ? last > ma200 : null,
    });
  }
  const sectorScore = (r: Omit<SectorSignal, 'rank'>) => r.ret6m ?? r.ret12m ?? -Infinity;
  const sectors: SectorSignal[] = sectorRows
    .sort((a, b) => sectorScore(b) - sectorScore(a))
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const sectorMom = new Map(sectors.map((s) => [s.sector, s.ret6m]));

  // §3.9.1 cluster-demeaned 5-day returns.
  for (const [, members] of bySector) {
    const vals = members.map((w) => w.rev5).filter((x): x is number => x !== null);
    if (vals.length < 2) continue;
    const m = mean(vals);
    for (const w of members) if (w.rev5 !== null) w.sig.rev5dDemeaned = w.rev5 - m;
  }

  // §3.6 multifactor: average of demeaned ranks of the available factors (at least 3 of 4).
  const fMom = work.map((w) => w.sig.mom12_1);
  const fRes = work.map((w) => w.sig.resMom);
  const fLowVol = work.map((w) => (w.sig.vol !== null ? -w.sig.vol : null));
  const fSector = work.map((w) => sectorMom.get(w.m.sector) ?? null);
  const factors = [fMom, fRes, fLowVol, fSector];
  const dRanks = factors.map(demeanedRanks);
  const composite: (number | null)[] = work.map((_, i) => {
    const vals = dRanks.map((d) => d[i]).filter((x): x is number => x !== null);
    return vals.length >= 3 ? mean(vals) : null;
  });
  const pMom = percentiles(fMom);
  const pRes = percentiles(fRes);
  const pLow = percentiles(fLowVol);
  const pSec = percentiles(fSector);
  const pComp = percentiles(composite);
  const pRev = percentiles(work.map((w) => (w.sig.rev5dDemeaned !== null ? -w.sig.rev5dDemeaned : null)));

  work.forEach((w, i) => {
    const s = w.sig;
    s.pct = {
      momentum: pMom[i],
      residualMomentum: pRes[i],
      lowVol: pLow[i],
      sector: pSec[i],
      composite: pComp[i],
      reversal: pRev[i],
    };
    s.composite = composite[i];
    s.decile = pComp[i] !== null ? Math.min(10, Math.floor((pComp[i] as number) / 10) + 1) : null;
    s.tags = tagsFor(s, sectors);
  });

  const stocks = work
    .map((w) => roundSignal(w.sig))
    .sort((a, b) => (b.pct.composite ?? -1) - (a.pct.composite ?? -1));
  const regime = bench ? regimeOf(bench) : null;

  return {
    version: 1,
    computedAt: input.computedAt,
    asOfDay: days[days.length - 1],
    universeSize: input.universe.length,
    covered: stocks.filter((s) => s.pct.composite !== null).length,
    stocks,
    sectors: sectors.map((s) => ({
      ...s,
      ret6m: s.ret6m !== null ? round(s.ret6m, 4) : null,
      ret12m: s.ret12m !== null ? round(s.ret12m, 4) : null,
    })),
    regime: regime
      ? {
          ...regime,
          close: round(regime.close),
          sma100: regime.sma100 !== null ? round(regime.sma100) : null,
          sma200: regime.sma200 !== null ? round(regime.sma200) : null,
          ret6m: regime.ret6m !== null ? round(regime.ret6m, 4) : null,
          mom12_1: regime.mom12_1 !== null ? round(regime.mom12_1, 4) : null,
        }
      : null,
  };
}

function tagsFor(s: StockSignal, sectors: SectorSignal[]): string[] {
  const tags: string[] = [];
  if (s.decile === 10) tags.push('Top decile');
  if ((s.pct.momentum ?? 0) >= 90) tags.push('Momentum leader');
  if ((s.pct.residualMomentum ?? 0) >= 90) tags.push('Residual momentum');
  if ((s.pct.lowVol ?? 0) >= 90) tags.push('Low volatility');
  const sec = sectors.find((x) => x.sector === s.sector);
  if (sec && sec.rank <= 3 && sec.aboveMa100) tags.push('Leading sector');
  if (s.ma3 === 'up') tags.push('3-MA up');
  if (s.aboveSma200 === false) tags.push('Below 200 DMA');
  if ((s.pct.reversal ?? 0) >= 85 && (s.pct.composite ?? 0) >= 60) tags.push('Pullback in a leader');
  if (s.channel?.atFloor) tags.push('At channel floor');
  if (s.channel?.atCeiling) tags.push('At channel ceiling');
  return tags;
}

function roundSignal(s: StockSignal): StockSignal {
  const r4 = (x: number | null) => (x === null ? null : round(x, 4));
  const r1 = (x: number | null) => (x === null ? null : round(x, 1));
  return {
    ...s,
    price: round(s.price),
    mom12_1: r4(s.mom12_1),
    momRiskAdj: r4(s.momRiskAdj),
    vol: r4(s.vol),
    resMom: r4(s.resMom),
    beta: r4(s.beta),
    alpha: r4(s.alpha),
    r2: r4(s.r2),
    ret1m: r4(s.ret1m),
    ret6m: r4(s.ret6m),
    rev5dDemeaned: r4(s.rev5dDemeaned),
    composite: r4(s.composite),
    channel: s.channel
      ? { ...s.channel, high: round(s.channel.high), low: round(s.channel.low), position: round(s.channel.position, 3) }
      : null,
    pct: {
      momentum: r1(s.pct.momentum),
      residualMomentum: r1(s.pct.residualMomentum),
      lowVol: r1(s.pct.lowVol),
      sector: r1(s.pct.sector),
      composite: r1(s.pct.composite),
      reversal: r1(s.pct.reversal),
    },
  };
}
