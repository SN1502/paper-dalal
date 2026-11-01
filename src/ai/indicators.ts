/**
 * Technical indicators computed on the phone from daily candles, so the AI gets
 * exact numbers instead of guessing them from a chart.
 */
import type { Candle } from '../engine/types';

const r2 = (x: number) => Math.round(x * 100) / 100;

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

/** Full EMA series (first value seeded with the SMA of the first `period` values). */
export function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function ema(values: number[], period: number): number | null {
  const s = emaSeries(values, period);
  return s.length ? s[s.length - 1] : null;
}

/** Wilder's RSI. */
export function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function macd(values: number[], fast = 12, slow = 26, signal = 9): { macd: number; signal: number; histogram: number } | null {
  if (values.length < slow + signal) return null;
  const f = emaSeries(values, fast);
  const s = emaSeries(values, slow);
  // Align: the slow series starts (slow - fast) bars later than the fast one.
  const offset = slow - fast;
  const line: number[] = [];
  for (let i = 0; i < s.length; i++) line.push(f[i + offset] - s[i]);
  const sig = emaSeries(line, signal);
  if (!sig.length) return null;
  const m = line[line.length - 1];
  const sg = sig[sig.length - 1];
  return { macd: m, signal: sg, histogram: m - sg };
}

/** Wilder's Average True Range. */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length <= period) return null;
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const pc = candles[i - 1].c;
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc)));
  }
  let a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a;
}

function pctChange(from: number | undefined, to: number): number | null {
  if (from === undefined || from === 0) return null;
  return ((to - from) / from) * 100;
}

export interface TechnicalSummary {
  last_close: number;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  ema20: number | null;
  rsi14: number | null;
  macd: { macd: number; signal: number; histogram: number } | null;
  atr14: number | null;
  atr_pct: number | null;
  return_pct: { '1w': number | null; '1m': number | null; '3m': number | null; '6m': number | null; '1y': number | null };
  high_52w: number;
  low_52w: number;
  pct_below_52w_high: number;
  pct_above_52w_low: number;
  support_20d: number;
  resistance_20d: number;
  avg_traded_value_20d_cr: number;
  volume_vs_20d_avg: number | null;
  trend: string;
  bars: number;
}

/** Summarises up to a year of daily candles (oldest first). */
export function summarize(candles: Candle[]): TechnicalSummary | null {
  const clean = candles.filter((c) => Number.isFinite(c.c) && c.c > 0);
  if (clean.length < 30) return null;
  const closes = clean.map((c) => c.c);
  const last = closes[closes.length - 1];
  const at = (barsAgo: number) => closes[closes.length - 1 - barsAgo];
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const a = atr(clean, 14);
  const year = clean.slice(-252);
  const high = Math.max(...year.map((c) => c.h));
  const low = Math.min(...year.map((c) => c.l));
  const last20 = clean.slice(-20);
  const tradedValue = last20.reduce((acc, c) => acc + c.c * c.v, 0) / last20.length;
  const avgVol = last20.slice(0, -1).reduce((acc, c) => acc + c.v, 0) / Math.max(1, last20.length - 1);
  const lastVol = clean[clean.length - 1].v;

  let trend = 'sideways';
  if (s50 !== null && s200 !== null) {
    if (last > s50 && s50 > s200) trend = 'uptrend (price > 50 DMA > 200 DMA)';
    else if (last < s50 && s50 < s200) trend = 'downtrend (price < 50 DMA < 200 DMA)';
    else if (last > s200) trend = 'above 200 DMA, mixed short-term';
    else trend = 'below 200 DMA, mixed short-term';
  } else if (s50 !== null) {
    trend = last > s50 ? 'above 50 DMA (under a year of data)' : 'below 50 DMA (under a year of data)';
  }

  const m = macd(closes);
  const rs = rsi(closes, 14);
  return {
    last_close: r2(last),
    sma20: s20 !== null ? r2(s20) : null,
    sma50: s50 !== null ? r2(s50) : null,
    sma200: s200 !== null ? r2(s200) : null,
    ema20: (() => {
      const e = ema(closes, 20);
      return e !== null ? r2(e) : null;
    })(),
    rsi14: rs !== null ? r2(rs) : null,
    macd: m ? { macd: r2(m.macd), signal: r2(m.signal), histogram: r2(m.histogram) } : null,
    atr14: a !== null ? r2(a) : null,
    atr_pct: a !== null ? r2((a / last) * 100) : null,
    return_pct: {
      '1w': round(pctChange(at(5), last)),
      '1m': round(pctChange(at(21), last)),
      '3m': round(pctChange(at(63), last)),
      '6m': round(pctChange(at(126), last)),
      '1y': round(pctChange(at(251), last)),
    },
    high_52w: r2(high),
    low_52w: r2(low),
    pct_below_52w_high: r2(((high - last) / high) * 100),
    pct_above_52w_low: r2(((last - low) / low) * 100),
    support_20d: r2(Math.min(...last20.map((c) => c.l))),
    resistance_20d: r2(Math.max(...last20.map((c) => c.h))),
    avg_traded_value_20d_cr: r2(tradedValue / 1e7),
    volume_vs_20d_avg: avgVol > 0 ? r2(lastVol / avgVol) : null,
    trend,
    bars: clean.length,
  };
}

function round(x: number | null): number | null {
  return x === null ? null : r2(x);
}
