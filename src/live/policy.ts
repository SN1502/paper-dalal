/**
 * When Live mode calls Claude, what it watches and how urgent each event is.
 * Pure functions, unit-tested.
 */
import { sectorOf } from '../data/instruments';
import type { EngineState, Instrument } from '../engine/types';
import { SESSION, formatHHMM, istDayKey } from '../lib/time';
import type { ScanResult } from '../strategies/scan';
import type { NewsItem } from './news';
import type { LiveSettings } from './risk';
import type { DayContext, LiveSignal } from './signals';
import type { LiveEvent } from './store';

const MINUTE = 60_000;
export const UNIVERSE_CAP = 40;
const TOP_SCAN = 15;
export const MAX_EVENTS_PER_CALL = 15;
const STALE_SIGNAL_MS = 20 * MINUTE;
const STALE_NEWS_MS = 90 * MINUTE;
/** First decision of the day, after the opening auction noise. */
export const FIRST_DECISION = SESSION.open + 5;
export const LAST_DECISION = 15 * 60 + 15;


/** Spend so far must stay under the day's budget spread across the session, with some slack. */
export function paceAllows(spent: number, budget: number, minuteOfDay: number, start = FIRST_DECISION, end = LAST_DECISION): boolean {
  if (spent >= budget) return false;
  const frac = Math.min(1, Math.max(0, (minuteOfDay - start) / Math.max(1, end - start)));
  return spent < budget * Math.min(1, frac + 0.15);
}

export function isStale(e: LiveEvent, now: number): boolean {
  return now - e.t > (e.kind === 'signal' ? STALE_SIGNAL_MS : STALE_NEWS_MS);
}

export interface TriggerInput {
  now: number;
  minuteOfDay: number;
  settings: LiveSettings;
  squareOffMinute: number;
  lastDecisionAt: number | null;
  spentToday: number;
  /** Events no decision has seen yet. */
  pending: LiveEvent[];
  openIntraday: number;
  /** Limits still allow new intraday entries. */
  canOpenNew: boolean;
}

export type TriggerDecision =
  | { run: true; reason: 'events' | 'check-in'; events: LiveEvent[] }
  | { run: false; why: string; nextCheckInAt: number | null };

export function decideTrigger(x: TriggerInput): TriggerDecision {
  const s = x.settings;
  const end = Math.min(LAST_DECISION, x.squareOffMinute - 5);
  if (x.minuteOfDay < FIRST_DECISION) return { run: false, why: `First decision at ${formatHHMM(FIRST_DECISION)}, after the opening noise`, nextCheckInAt: null };
  if (x.minuteOfDay >= end) return { run: false, why: `Done for today. Intraday positions square off at ${formatHHMM(x.squareOffMinute)}`, nextCheckInAt: null };
  if (x.spentToday >= s.dailyBudgetUsd) return { run: false, why: `Today’s live budget of $${s.dailyBudgetUsd.toFixed(2)} is used up`, nextCheckInAt: null };

  const relevant = x.pending
    .filter((e) => !isStale(e, x.now))
    .filter((e) => x.canOpenNew || e.priority >= 3)
    .sort((a, b) => b.priority - a.priority || b.t - a.t);
  const nextCheckInAt = x.lastDecisionAt === null ? x.now : x.lastDecisionAt + s.checkInMinutes * MINUTE;
  const gapOk = x.lastDecisionAt === null || x.now - x.lastDecisionAt >= s.minGapMinutes * MINUTE;
  const pace = paceAllows(x.spentToday, s.dailyBudgetUsd, x.minuteOfDay, FIRST_DECISION, end);
  const idle = x.canOpenNew ? 'Watching for setups' : x.openIntraday > 0 ? 'Entry limits reached; managing open positions' : 'No new intraday trades possible today; watching your positions only';
  if (!gapOk) return { run: false, why: idle, nextCheckInAt };
  const top = relevant[0]?.priority ?? 0;
  const events = relevant.slice(0, MAX_EVENTS_PER_CALL);
  if (top >= 3) return { run: true, reason: 'events', events };
  if (top >= 2 && pace) return { run: true, reason: 'events', events };
  if (x.now >= nextCheckInAt && (x.openIntraday > 0 || (x.canOpenNew && pace))) return { run: true, reason: 'check-in', events };
  if (top >= 2 && !pace) return { run: false, why: 'Pacing AI calls to stay within today’s budget', nextCheckInAt };
  return { run: false, why: idle, nextCheckInAt };
}

export interface UniverseInput {
  state: EngineState;
  scan: ScanResult | null;
  newsSymbols: string[];
  instrumentFor: (symbol: string) => Instrument;
  cap?: number;
}

/** Stocks Live mode watches: positions first, then the watchlist, stocks in the news and the top of the strategy scan. */
export function liveUniverse(x: UniverseInput): Instrument[] {
  const cap = x.cap ?? UNIVERSE_CAP;
  const out = new Map<string, Instrument>();
  const add = (i: Instrument | undefined) => {
    if (!i || out.size >= cap || out.has(i.symbol)) return;
    if (i.isIndex || i.exchange !== 'NSE' || sectorOf(i.symbol) === 'ETF') return;
    out.set(i.symbol, i);
  };
  for (const p of Object.values(x.state.positions)) if (p.netQty !== 0) add(p.instrument);
  for (const h of Object.values(x.state.holdings)) if (h.ai) add(h.instrument);
  for (const i of x.state.watchlist) add(i);
  for (const s of x.newsSymbols) add(x.instrumentFor(s));
  for (const r of (x.scan?.stocks ?? []).filter((r) => r.price >= 50).slice(0, TOP_SCAN)) add(x.instrumentFor(r.symbol));
  return [...out.values()];
}

export function signalPriority(sig: LiveSignal, held: { intraday: 'long' | 'short' | null; swing: boolean }): 1 | 2 | 3 {
  if (held.intraday && sig.direction !== held.intraday) return 3;
  if (held.intraday) return 2;
  if (held.swing) return sig.direction === 'short' ? 2 : 1;
  if (sig.kind === 'sharp_move_up' || sig.kind === 'sharp_move_down' || sig.kind === 'gap_up' || sig.kind === 'gap_down') return 2;
  return sig.strength >= 0.6 ? 2 : 1;
}

export function newsEvents(items: NewsItem[], held: (symbol: string) => boolean, now: number): LiveEvent[] {
  const out: LiveEvent[] = [];
  for (const n of items) {
    if (n.important && n.symbols.length) {
      const sym = n.symbols.find(held) ?? n.symbols[0];
      const others = n.symbols.filter((s) => s !== sym).map((s) => s.replace(/\.NS$/, ''));
      out.push({
        id: `n-${n.id}-${sym}`,
        t: now,
        kind: 'news',
        symbol: sym,
        title: n.title,
        detail: [n.source === 'nse' ? 'NSE filing' : 'headline', others.length ? `also mentions ${others.join(', ')}` : ''].filter(Boolean).join(' · '),
        direction: null,
        priority: n.symbols.some(held) ? 3 : 2,
        link: n.link || null,
        runId: null,
      });
    } else if (n.macro) {
      out.push({ id: `n-${n.id}`, t: now, kind: 'macro', symbol: null, title: n.title, detail: 'market-wide', direction: null, priority: 1, link: n.link || null, runId: null });
    }
  }
  return out;
}

export function previousDayContext(candles: { t: number; h: number; l: number; c: number }[], today: string): DayContext | null {
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    if (istDayKey(c.t) < today) return { prevHigh: c.h, prevLow: c.l, prevClose: c.c };
  }
  return null;
}

