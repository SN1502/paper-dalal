/**
 * Intraday signals on 1- and 5-minute bars. Each fires on the bar where its condition
 * becomes true; the live trader adds a cooldown so a signal isn't repeated.
 *
 *  §3.14 support and resistance: price crossing the day's pivot resistance R or support S
 *        (from the previous day's high, low and close)
 *  §3.15 channel: a break of the last hour's high or low on 5-minute bars
 *  §3.12 two moving averages: EMA(9) crossing EMA(21) on 5-minute bars, filtered by VWAP
 *  Opening-range breakout (first 15 minutes), volume spikes, sharp 15-minute moves and
 *  opening gaps, which mark the moves news usually causes.
 */
import { formatIstTime } from '../lib/time';
import { round } from '../strategies/math';
import { aggregate, emaSeries, openingRange, vwap, type IntradayState, type MinuteBar } from './bars';

const MINUTE = 60_000;

export interface DayContext {
  prevHigh: number;
  prevLow: number;
  prevClose: number;
}

export type SignalKind =
  | 'gap_up'
  | 'gap_down'
  | 'orb_breakout'
  | 'orb_breakdown'
  | 'pivot_resistance_break'
  | 'pivot_support_break'
  | 'channel_breakout'
  | 'channel_breakdown'
  | 'ema_cross_up'
  | 'ema_cross_down'
  | 'volume_spike'
  | 'sharp_move_up'
  | 'sharp_move_down';

export interface LiveSignal {
  symbol: string;
  kind: SignalKind;
  direction: 'long' | 'short';
  price: number;
  time: number;
  /** 0–1; higher when volume confirms. */
  strength: number;
  message: string;
  /** Section of "151 Trading Strategies" the rule comes from, when it does. */
  paper: string | null;
}

export const SIGNAL_LABEL: Record<SignalKind, string> = {
  gap_up: 'Gap up',
  gap_down: 'Gap down',
  orb_breakout: 'Opening-range breakout',
  orb_breakdown: 'Opening-range breakdown',
  pivot_resistance_break: 'Above pivot resistance',
  pivot_support_break: 'Below pivot support',
  channel_breakout: 'Hourly channel breakout',
  channel_breakdown: 'Hourly channel breakdown',
  ema_cross_up: 'EMA 9/21 cross up',
  ema_cross_down: 'EMA 9/21 cross down',
  volume_spike: 'Volume spike',
  sharp_move_up: 'Sharp rise',
  sharp_move_down: 'Sharp fall',
};

export function pivotLevels(ctx: DayContext) {
  const c = (ctx.prevHigh + ctx.prevLow + ctx.prevClose) / 3;
  return { pivot: c, resistance: 2 * c - ctx.prevLow, support: 2 * c - ctx.prevHigh };
}

/** Last completed bar's volume relative to the 20 bars before it; null without volume data. */
export function volumeRatio(bars: MinuteBar[]): number | null {
  if (bars.length < 7) return null;
  const done = bars[bars.length - 2];
  const prior = bars.slice(Math.max(0, bars.length - 22), bars.length - 2);
  const avg = prior.reduce((a, b) => a + b.v, 0) / prior.length;
  if (!(avg > 0) || !(done.v > 0)) return null;
  return done.v / avg;
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;

export function detectSignals(symbol: string, state: IntradayState, ctx: DayContext | null, now: number): LiveSignal[] {
  const bars = state.bars;
  if (bars.length === 0) return [];
  const cur = bars[bars.length - 1];
  const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
  const price = cur.c;
  const out: LiveSignal[] = [];
  const vr = volumeRatio(bars);
  const strength = (base: number) => round(Math.min(1, base + (vr !== null ? Math.min(0.4, Math.max(0, (vr - 1) / 5)) : 0)), 2);
  const push = (kind: SignalKind, direction: 'long' | 'short', message: string, base: number, paper: string | null = null) =>
    out.push({ symbol, kind, direction, price: round(price), time: now, strength: strength(base), message, paper });
  const crossedUp = (level: number) => prev !== null && prev.c <= level && price > level;
  const crossedDown = (level: number) => prev !== null && prev.c >= level && price < level;

  // Opening gap, in the first ten minutes only.
  if (ctx && now - bars[0].t < 10 * MINUTE) {
    const gap = bars[0].o / ctx.prevClose - 1;
    if (gap >= 0.02) push('gap_up', 'long', `Opened ${pct(gap)} above yesterday's close`, 0.5);
    if (gap <= -0.02) push('gap_down', 'short', `Opened ${pct(gap)} below yesterday's close`, 0.5);
  }

  // Opening-range breakout after 9:30.
  const or = openingRange(bars, 15);
  if (or?.complete) {
    if (crossedUp(or.high)) push('orb_breakout', 'long', `Broke the 9:15–9:30 high of ${round(or.high)}`, 0.5);
    if (crossedDown(or.low)) push('orb_breakdown', 'short', `Broke the 9:15–9:30 low of ${round(or.low)}`, 0.5);
  }

  // §3.14 pivot resistance and support from the previous day.
  if (ctx) {
    const pv = pivotLevels(ctx);
    if (crossedUp(pv.resistance)) push('pivot_resistance_break', 'long', `Crossed pivot resistance R ${round(pv.resistance)}`, 0.55, '§3.14');
    if (crossedDown(pv.support)) push('pivot_support_break', 'short', `Crossed pivot support S ${round(pv.support)}`, 0.55, '§3.14');
  }

  const five = aggregate(bars, 5);
  // §3.15 channel: the previous 12 five-minute bars (one hour), excluding the current one.
  if (five.length >= 13) {
    const window = five.slice(-13, -1);
    const hi = Math.max(...window.map((b) => b.h));
    const lo = Math.min(...window.map((b) => b.l));
    if (crossedUp(hi)) push('channel_breakout', 'long', `Broke the last hour's high of ${round(hi)}`, 0.5, '§3.15');
    if (crossedDown(lo)) push('channel_breakdown', 'short', `Broke the last hour's low of ${round(lo)}`, 0.5, '§3.15');
  }

  // §3.12 EMA(9)/EMA(21) cross on 5-minute closes, with a VWAP filter.
  if (five.length >= 23) {
    const closes = five.map((b) => b.c);
    const e9 = emaSeries(closes, 9);
    const e21 = emaSeries(closes, 21);
    const off = e9.length - e21.length;
    const a1 = e9[e9.length - 2];
    const a2 = e9[e9.length - 1];
    const b1 = e21[e21.length - 2];
    const b2 = e21[e21.length - 1];
    const vw = vwap(bars);
    if (off >= 0 && a1 <= b1 && a2 > b2 && (vw === null || price > vw))
      push('ema_cross_up', 'long', `EMA(9) crossed above EMA(21) on 5-min bars${vw !== null ? ', above VWAP' : ''}`, 0.45, '§3.12');
    if (off >= 0 && a1 >= b1 && a2 < b2 && (vw === null || price < vw))
      push('ema_cross_down', 'short', `EMA(9) crossed below EMA(21) on 5-min bars${vw !== null ? ', below VWAP' : ''}`, 0.45, '§3.12');
  }

  // Volume spike on the last completed minute.
  if (prev && vr !== null && vr >= 3) {
    const move = prev.c / prev.o - 1;
    if (Math.abs(move) >= 0.003) {
      push('volume_spike', move > 0 ? 'long' : 'short', `${vr.toFixed(1)}× normal volume in the ${formatIstTime(prev.t, false)} minute, ${pct(move)}`, 0.6);
    }
  }

  // Sharp 15-minute move, firing on the bar that crosses ±1.5%.
  const ref = [...bars].reverse().find((b) => b.t <= cur.t - 15 * MINUTE);
  const refPrev = prev ? [...bars].reverse().find((b) => b.t <= prev.t - 15 * MINUTE) : undefined;
  if (ref && prev && refPrev) {
    const ch = price / ref.c - 1;
    const chPrev = prev.c / refPrev.c - 1;
    if (ch >= 0.015 && chPrev < 0.015) push('sharp_move_up', 'long', `Up ${pct(ch)} in 15 minutes`, 0.55);
    if (ch <= -0.015 && chPrev > -0.015) push('sharp_move_down', 'short', `Down ${pct(ch)} in 15 minutes`, 0.55);
  }
  return out;
}

/** Compact intraday picture of one stock for the AI. */
export function intradaySummary(state: IntradayState, ctx: DayContext | null, ltp: number | null) {
  const bars = state.bars;
  if (bars.length === 0) return null;
  const price = ltp ?? bars[bars.length - 1].c;
  const five = aggregate(bars, 5);
  const vw = vwap(bars);
  const or = openingRange(bars, 15);
  const closes5 = five.map((b) => b.c);
  const e9 = emaSeries(closes5, 9);
  const e21 = emaSeries(closes5, 21);
  const volumeToday = bars.reduce((a, b) => a + b.v, 0);
  return {
    ltp: round(price),
    open: round(bars[0].o),
    high: round(Math.max(...bars.map((b) => b.h))),
    low: round(Math.min(...bars.map((b) => b.l))),
    change_vs_prev_close_pct: ctx ? round((price / ctx.prevClose - 1) * 100) : null,
    vwap: vw !== null ? round(vw) : null,
    vs_vwap_pct: vw !== null ? round((price / vw - 1) * 100) : null,
    opening_range: or ? { high: round(or.high), low: round(or.low), complete: or.complete } : null,
    pivots_from_previous_day: ctx
      ? (() => {
          const pv = pivotLevels(ctx);
          return { support: round(pv.support), pivot: round(pv.pivot), resistance: round(pv.resistance) };
        })()
      : null,
    ema9_5m: e9.length ? round(e9[e9.length - 1]) : null,
    ema21_5m: e21.length ? round(e21[e21.length - 1]) : null,
    volume_today: volumeToday || null,
    last_minute_volume_vs_avg: (() => {
      const r = volumeRatio(bars);
      return r !== null ? round(r) : null;
    })(),
    last_5min_bars: five.slice(-8).map((b) => ({ time: formatIstTime(b.t, false), o: round(b.o), h: round(b.h), l: round(b.l), c: round(b.c), v: b.v })),
  };
}
