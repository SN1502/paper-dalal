/**
 * Intraday 1-minute bars for live trading: seeded from Yahoo's 1-minute chart and kept
 * current from each price refresh. All functions are pure.
 */
import type { Candle } from '../engine/types';
import { SESSION, istDayKey, istTimestamp } from '../lib/time';

const MINUTE = 60_000;

export interface MinuteBar {
  /** Start of the minute (epoch ms). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface IntradayState {
  day: string;
  bars: MinuteBar[];
  /** Day volume at the last tick, to turn cumulative volume into per-bar volume. */
  lastCumVolume: number | null;
}

export function emptyIntraday(day: string): IntradayState {
  return { day, bars: [], lastCumVolume: null };
}

function inSession(t: number): boolean {
  const day = istDayKey(t);
  return t >= istTimestamp(day, SESSION.open) && t < istTimestamp(day, SESSION.close);
}

/** Replaces bars covered by fresh 1-minute candles (today's only), keeping later tick-built bars. */
export function mergeCandles(state: IntradayState, candles: Candle[]): IntradayState {
  const today = candles.filter((c) => istDayKey(c.t) === state.day && inSession(c.t));
  if (today.length === 0) return state;
  const byMinute = new Map<number, MinuteBar>();
  for (const b of state.bars) byMinute.set(b.t, b);
  for (const c of today) {
    const t = Math.floor(c.t / MINUTE) * MINUTE;
    byMinute.set(t, { t, o: c.o, h: c.h, l: c.l, c: c.c, v: Number.isFinite(c.v) ? c.v : 0 });
  }
  return { ...state, bars: [...byMinute.values()].sort((a, b) => a.t - b.t) };
}

/** Updates the current minute's bar with a new price (and cumulative day volume, if known). */
export function applyTick(state: IntradayState, price: number, cumVolume: number | null, time: number): IntradayState {
  if (!(price > 0) || istDayKey(time) !== state.day || !inSession(time)) return state;
  const t = Math.floor(time / MINUTE) * MINUTE;
  const dv = cumVolume !== null && state.lastCumVolume !== null ? Math.max(0, cumVolume - state.lastCumVolume) : 0;
  const bars = state.bars.slice();
  const last = bars[bars.length - 1];
  if (last && last.t === t) {
    bars[bars.length - 1] = { ...last, h: Math.max(last.h, price), l: Math.min(last.l, price), c: price, v: last.v + dv };
  } else if (!last || last.t < t) {
    bars.push({ t, o: price, h: price, l: price, c: price, v: dv });
  } else {
    return { ...state, lastCumVolume: cumVolume ?? state.lastCumVolume };
  }
  return { ...state, bars, lastCumVolume: cumVolume ?? state.lastCumVolume };
}

/** Aggregates 1-minute bars into n-minute bars aligned to the 9:15 open. */
export function aggregate(bars: MinuteBar[], minutes: number): MinuteBar[] {
  if (bars.length === 0) return [];
  const open = istTimestamp(istDayKey(bars[0].t), SESSION.open);
  const size = minutes * MINUTE;
  const out: MinuteBar[] = [];
  for (const b of bars) {
    const t = open + Math.floor((b.t - open) / size) * size;
    const cur = out[out.length - 1];
    if (cur && cur.t === t) {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    } else {
      out.push({ ...b, t });
    }
  }
  return out;
}

/** Volume-weighted average price of the session; null without volume. */
export function vwap(bars: MinuteBar[]): number | null {
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    pv += ((b.h + b.l + b.c) / 3) * b.v;
    v += b.v;
  }
  return v > 0 ? pv / v : null;
}

/** First `minutes` of the session; complete once the window has passed. */
export function openingRange(bars: MinuteBar[], minutes = 15): { high: number; low: number; complete: boolean } | null {
  if (bars.length === 0) return null;
  const end = istTimestamp(istDayKey(bars[0].t), SESSION.open) + minutes * MINUTE;
  const inRange = bars.filter((b) => b.t < end);
  if (inRange.length === 0) return null;
  return {
    high: Math.max(...inRange.map((b) => b.h)),
    low: Math.min(...inRange.map((b) => b.l)),
    complete: bars[bars.length - 1].t >= end,
  };
}

export function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [prev];
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
