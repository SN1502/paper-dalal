/** Small numeric helpers for the strategy engine. All functions are pure. */

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (divides by n − 1), as in the paper's eq. (270). */
export function stdev(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

export function sma(values: number[], period: number, end = values.length): number | null {
  if (period <= 0 || end < period) return null;
  let s = 0;
  for (let i = end - period; i < end; i++) s += values[i];
  return s / period;
}

/** Simple returns between consecutive values. */
export function returns(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) out.push(values[i] / values[i - 1] - 1);
  return out;
}

export interface Ols {
  alpha: number;
  beta: number;
  r2: number;
  residuals: number[];
}

/** Ordinary least squares of y on x with an intercept. */
export function ols(y: number[], x: number[]): Ols | null {
  const n = Math.min(y.length, x.length);
  if (n < 10) return null;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) * (x[i] - mx);
    sxy += (x[i] - mx) * (y[i] - my);
  }
  if (sxx === 0) return null;
  const beta = sxy / sxx;
  const alpha = my - beta * mx;
  const residuals: number[] = [];
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const e = y[i] - alpha - beta * x[i];
    residuals.push(e);
    ssRes += e * e;
    ssTot += (y[i] - my) * (y[i] - my);
  }
  return { alpha, beta, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0, residuals };
}

/**
 * Ranks (1 = smallest) with ties sharing their average rank; null entries stay null.
 * Matches the rank(f) used for the demeaned-rank combination in the paper's eq. (276).
 */
export function ranks(values: (number | null)[]): (number | null)[] {
  const idx = values
    .map((v, i) => ({ v, i }))
    .filter((e): e is { v: number; i: number } => e.v !== null && Number.isFinite(e.v))
    .sort((a, b) => a.v - b.v);
  const out: (number | null)[] = values.map(() => null);
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1].v === idx[k].v) j++;
    const avg = (k + j) / 2 + 1;
    for (let m = k; m <= j; m++) out[idx[m].i] = avg;
    k = j + 1;
  }
  return out;
}

/** Percentile 0–100 of each value within the non-null set (100 = largest). */
export function percentiles(values: (number | null)[]): (number | null)[] {
  const r = ranks(values);
  const n = r.filter((x) => x !== null).length;
  return r.map((x) => (x === null ? null : n <= 1 ? 50 : ((x - 1) / (n - 1)) * 100));
}

/** Demeaned ranks, eq. (276): s = rank(f) − mean rank, over the non-null entries. */
export function demeanedRanks(values: (number | null)[]): (number | null)[] {
  const r = ranks(values);
  const valid = r.filter((x): x is number => x !== null);
  if (valid.length === 0) return r;
  const m = mean(valid);
  return r.map((x) => (x === null ? null : x - m));
}

export const round = (x: number, d = 2) => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};
