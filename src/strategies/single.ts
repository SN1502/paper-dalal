/**
 * Single-stock signals from "151 Trading Strategies", computed on daily OHLCV candles:
 *   §3.14 support and resistance (pivot point), daily and weekly
 *   §3.17 single-stock KNN forecast with a time-ordered 60/40 validation
 *   §4.4  internal bar strength (IBS)
 */
import type { Candle } from '../engine/types';
import { round } from './math';

export interface Pivot {
  pivot: number;
  resistance: number;
  support: number;
  /** §3.14 rule: long bias above the pivot (take profit at R), short bias below it. */
  bias: 'long' | 'short';
}

/** Eq. (325)–(327): C = (H + L + Close)/3, R = 2C − L, S = 2C − H. */
export function pivotFrom(high: number, low: number, close: number, price: number): Pivot {
  const c = (high + low + close) / 3;
  return { pivot: round(c), resistance: round(2 * c - low), support: round(2 * c - high), bias: price > c ? 'long' : 'short' };
}

/** Daily pivot from the last completed bar; weekly pivot from the last five completed bars. */
export function pivots(completed: Candle[], price: number): { daily: Pivot | null; weekly: Pivot | null } {
  if (completed.length === 0) return { daily: null, weekly: null };
  const d = completed[completed.length - 1];
  const w = completed.slice(-5);
  return {
    daily: pivotFrom(d.h, d.l, d.c, price),
    weekly:
      w.length === 5 ? pivotFrom(Math.max(...w.map((x) => x.h)), Math.min(...w.map((x) => x.l)), w[w.length - 1].c, price) : null,
  };
}

/** Eq. (370): IBS = (Close − Low)/(High − Low) of the last completed bar. Low IBS favours a rebound. */
export function ibs(completed: Candle[]): number | null {
  const d = completed[completed.length - 1];
  if (!d || d.h <= d.l) return null;
  return round((d.c - d.l) / (d.h - d.l), 3);
}

export interface KnnResult {
  horizonDays: number;
  /** Predicted return over the horizon, as a fraction. */
  forecast: number;
  k: number;
  samples: number;
  /** Share of validation predictions with the right sign. */
  cvHitRate: number;
  /** Share of validation periods that went up (the naive "always long" hit rate). */
  cvUpShare: number;
  cvCorrelation: number | null;
  /** Eq. (341) with z1 = 2%. */
  signal: 'long' | 'avoid' | 'neutral';
}

const smaAt = (xs: number[], end: number, n: number) => {
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) s += xs[i];
  return s / n;
};

function features(c: number[], v: number[], i: number): number[] {
  const ratio = (x: number, y: number) => (y > 0 ? x / y : 1);
  return [
    ratio(c[i], smaAt(c, i, 5)) - 1,
    ratio(c[i], smaAt(c, i, 10)) - 1,
    ratio(c[i], smaAt(c, i, 21)) - 1,
    ratio(c[i], smaAt(c, i, 50)) - 1,
    ratio(v[i], smaAt(v, i, 5)),
    ratio(v[i], smaAt(v, i, 21)),
  ];
}

function minMax(rows: number[][]): { lo: number[]; hi: number[] } {
  const dims = rows[0].length;
  const lo = new Array(dims).fill(Infinity);
  const hi = new Array(dims).fill(-Infinity);
  for (const r of rows)
    for (let d = 0; d < dims; d++) {
      if (r[d] < lo[d]) lo[d] = r[d];
      if (r[d] > hi[d]) hi[d] = r[d];
    }
  return { lo, hi };
}

/** Eq. (337) min-max normalisation. */
function normalize(x: number[], lo: number[], hi: number[]): number[] {
  return x.map((v, d) => (hi[d] > lo[d] ? (v - lo[d]) / (hi[d] - lo[d]) : 0));
}

/** Eq. (338)–(339): average target of the k nearest neighbours by Euclidean distance. */
function predict(x: number[], train: { x: number[]; y: number }[], k: number): number {
  const dist = train.map((t) => {
    let d = 0;
    for (let j = 0; j < x.length; j++) d += (x[j] - t.x[j]) ** 2;
    return { d, y: t.y };
  });
  dist.sort((a, b) => a.d - b.d);
  let s = 0;
  const n = Math.min(k, dist.length);
  for (let i = 0; i < n; i++) s += dist[i].y;
  return n > 0 ? s / n : 0;
}

function correlation(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 3) return null;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

/**
 * §3.17 single-stock KNN. Target Y(t) = P(t + T)/P(t) − 1 (eq. 332, written forward in time);
 * predictors are price and volume moving-average ratios (eq. 333–336); k = floor(√sample size).
 */
export function knnForecast(candles: Candle[], horizon = 10, threshold = 0.02): KnnResult | null {
  const c = candles.map((x) => x.c);
  const v = candles.map((x) => (Number.isFinite(x.v) ? x.v : 0));
  const first = 49;
  const lastLabeled = c.length - 1 - horizon;
  if (lastLabeled - first + 1 < 60) return null;

  const labeled: { x: number[]; y: number }[] = [];
  for (let i = first; i <= lastLabeled; i++) labeled.push({ x: features(c, v, i), y: c[i + horizon] / c[i] - 1 });

  // Time-ordered 60/40 split for validation (no look-ahead).
  const cut = Math.floor(labeled.length * 0.6);
  const trainRaw = labeled.slice(0, cut);
  const cvRaw = labeled.slice(cut);
  const tr = minMax(trainRaw.map((s) => s.x));
  const train = trainRaw.map((s) => ({ x: normalize(s.x, tr.lo, tr.hi), y: s.y }));
  const kTrain = Math.max(1, Math.floor(Math.sqrt(train.length)));
  const preds: number[] = [];
  const actual: number[] = [];
  let hits = 0;
  let ups = 0;
  for (const s of cvRaw) {
    const p = predict(normalize(s.x, tr.lo, tr.hi), train, kTrain);
    preds.push(p);
    actual.push(s.y);
    if (p > 0 === s.y > 0) hits++;
    if (s.y > 0) ups++;
  }

  // Final forecast uses every labelled sample.
  const all = minMax(labeled.map((s) => s.x));
  const allNorm = labeled.map((s) => ({ x: normalize(s.x, all.lo, all.hi), y: s.y }));
  const k = Math.max(1, Math.floor(Math.sqrt(allNorm.length)));
  const forecast = predict(normalize(features(c, v, c.length - 1), all.lo, all.hi), allNorm, k);
  const corr = correlation(preds, actual);
  return {
    horizonDays: horizon,
    forecast: round(forecast, 4),
    k,
    samples: labeled.length,
    cvHitRate: round(hits / Math.max(1, cvRaw.length), 3),
    cvUpShare: round(ups / Math.max(1, cvRaw.length), 3),
    cvCorrelation: corr !== null ? round(corr, 3) : null,
    signal: forecast > threshold ? 'long' : forecast < -threshold ? 'avoid' : 'neutral',
  };
}
