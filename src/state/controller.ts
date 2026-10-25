/**
 * Drives the app: polls prices, feeds them to the engine, replays missed candles after
 * the app was closed, and turns engine events into toasts and haptics.
 */
import * as Haptics from 'expo-haptics';
import { AppState, type AppStateStatus } from 'react-native';
import { useEffect, useState } from 'react';

import { fetchQuote, fetchQuotes, isBatchAvailable, isYahooCoolingDown } from '../data/feed';
import { mapLimit } from '../data/http';
import { BENCHMARK, INDICES, instrumentFromSymbol } from '../data/instruments';
import { yahooCandles } from '../data/yahoo';
import {
  addToWatchlist,
  cancelOrder,
  isActive,
  modifyOrder,
  moveInWatchlist,
  placeOrder,
  pricesFromQuotes,
  processQuotes,
  removeFromWatchlist,
  replayCandles,
  resetAccount,
  updateSettings,
  type ModifyChanges,
} from '../engine/engine';
import type { Candle, EngineEvent, EngineResult, Instrument, Order, OrderInput, Quote, Settings } from '../engine/types';
import { SESSION, addDays, clockPhase, istDayKey, istParts, istTimestamp, isWeekday } from '../lib/time';
import { engineStore } from './engineStore';
import { quoteStore } from './quoteStore';
import { feedStatusStore, toastStore } from './uiStores';

const REPLAY_GAP_MS = 90_000;

function announce(events: EngineEvent[]) {
  if (events.length === 0) return;
  toastStore.push(events);
  const kinds = new Set(events.map((e) => e.kind));
  if (kinds.has('reject')) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
  else if (kinds.has('fill') || kinds.has('squareoff'))
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  else if (kinds.has('trigger')) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
}

function commit(r: EngineResult) {
  engineStore.set(r.state);
  announce(r.events);
}

class MarketController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private appState: AppStateStatus | string = AppState.currentState ?? 'active';
  private focus = new Map<string, { inst: Instrument; count: number }>();
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    AppState.addEventListener('change', (next) => {
      const wasActive = this.appState === 'active';
      this.appState = next;
      if (next === 'active' && !wasActive) void this.refresh();
      if (next !== 'active') {
        this.clearTimer();
        void engineStore.flush();
        void quoteStore.save();
      }
    });
    void this.refresh();
  }

  /** Keeps a symbol's price updating while a screen shows it. */
  focusSymbol(inst: Instrument): () => void {
    const cur = this.focus.get(inst.symbol);
    this.focus.set(inst.symbol, { inst, count: (cur?.count ?? 0) + 1 });
    if (!quoteStore.get(inst.symbol)) void this.fetchOne(inst);
    return () => {
      const c = this.focus.get(inst.symbol);
      if (!c) return;
      if (c.count <= 1) this.focus.delete(inst.symbol);
      else this.focus.set(inst.symbol, { ...c, count: c.count - 1 });
    };
  }

  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.clearTimer();
    this.inFlight = this.cycle().finally(() => {
      this.inFlight = null;
      this.schedule();
    });
    return this.inFlight;
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule() {
    this.clearTimer();
    if (this.appState !== 'active' || !engineStore.isReady()) return;
    const phase = clockPhase(Date.now());
    const base = engineStore.get().settings.refreshSeconds;
    let seconds: number;
    if (phase === 'open') seconds = isYahooCoolingDown() ? Math.max(15, base) : base;
    else if (phase === 'pre-open') seconds = 15;
    else seconds = 60;
    this.timer = setTimeout(() => void this.refresh(), seconds * 1000);
  }

  private lastFetched = new Map<string, number>();

  /**
   * Symbols to refresh this cycle. With the batch endpoint everything goes in one request.
   * Without it, symbols that can execute something (open orders, open positions, the screen
   * in view) refresh every cycle and the rest at most every 15 s, to stay under rate limits.
   */
  private instruments(now: number): Instrument[] {
    const s = engineStore.get();
    const priority = new Map<string, Instrument>();
    for (const o of s.orders) if (isActive(o)) priority.set(o.instrument.symbol, o.instrument);
    for (const p of Object.values(s.positions)) if (p.netQty !== 0) priority.set(p.instrument.symbol, p.instrument);
    for (const f of this.focus.values()) priority.set(f.inst.symbol, f.inst);

    const background = new Map<string, Instrument>();
    for (const i of INDICES) background.set(i.symbol, i);
    for (const i of s.watchlist) background.set(i.symbol, i);
    for (const h of Object.values(s.holdings)) background.set(h.instrument.symbol, h.instrument);
    for (const p of Object.values(s.positions)) background.set(p.instrument.symbol, p.instrument);
    for (const k of priority.keys()) background.delete(k);

    if (isBatchAvailable(now)) return [...priority.values(), ...background.values()];
    const every = Math.max(15_000, s.settings.refreshSeconds * 3_000);
    const due = [...background.values()].filter((i) => now - (this.lastFetched.get(i.symbol) ?? 0) >= every - 500);
    return [...priority.values(), ...due];
  }

  private async fetchOne(inst: Instrument): Promise<Quote | null> {
    try {
      const q = await fetchQuote(inst);
      quoteStore.setMany([q]);
      return q;
    } catch {
      return null;
    }
  }

  private async cycle() {
    if (!engineStore.isReady()) return;
    const started = Date.now();
    feedStatusStore.set({ refreshing: true, lastAttemptAt: started });
    try {
      const { quotes, errors } = await fetchQuotes(this.instruments(started));
      quoteStore.setMany(quotes);
      for (const q of quotes) this.lastFetched.set(q.symbol, started);
      const sources = new Set(quotes.map((q) => q.source));
      feedStatusStore.set({
        source: quotes.length ? (sources.has('yahoo') ? 'yahoo' : 'google') : feedStatusStore.get().source,
        lastSuccessAt: quotes.length ? Date.now() : feedStatusStore.get().lastSuccessAt,
        lastError: quotes.length === 0 && errors.length ? errors[0].message : null,
        failing: errors.map((e) => e.symbol),
      });
      if (quotes.length === 0) return;

      await this.catchUp(Date.now());
      const now = Date.now();
      commit(processQuotes(engineStore.get(), quoteStore.record(), now));
      engineStore.setMeta({ lastEvalAt: now });
    } catch (e) {
      feedStatusStore.set({ lastError: e instanceof Error ? e.message : 'Refresh failed' });
    } finally {
      feedStatusStore.set({ refreshing: false });
    }
  }

  /**
   * If the app was away for a while with pending orders or open intraday positions,
   * replays 1-minute candles for that gap so fills and square-off happen at the right prices.
   */
  private async catchUp(now: number) {
    const from = engineStore.meta().lastEvalAt;
    if (!from || now - from < REPLAY_GAP_MS) return;
    const s = engineStore.get();
    const symbols = new Set<string>();
    for (const o of s.orders) if (isActive(o)) symbols.add(o.instrument.symbol);
    for (const p of Object.values(s.positions)) if (p.product === 'MIS' && p.netQty !== 0) symbols.add(p.instrument.symbol);
    if (symbols.size === 0) return;
    // Nothing to replay if the gap never touched a session.
    if (!gapTouchesSession(from, now)) return;

    const series: Record<string, Candle[]> = {};
    await mapLimit([...symbols], 3, async (sym) => {
      try {
        series[sym] = (await yahooCandles(sym, '5d', '1m')).candles;
      } catch {
        // Without candles the order is simply checked against live prices from now on.
      }
    });
    if (Object.keys(series).length === 0) return;
    commit(replayCandles(engineStore.get(), series, from, now, pricesFromQuotes(quoteStore.record())));
  }

  /* ---------- user actions ---------- */

  async quoteFor(inst: Instrument): Promise<Quote | null> {
    const q = quoteStore.get(inst.symbol);
    const stale = !q || Date.now() - q.fetchedAt > 20_000;
    if (stale && clockPhase(Date.now()) === 'open') return (await this.fetchOne(inst)) ?? q ?? null;
    if (!q) return this.fetchOne(inst);
    return q;
  }

  async placeOrder(input: OrderInput): Promise<{ order: Order | null; error: string | null }> {
    const quote = await this.quoteFor(input.instrument);
    const r = placeOrder(engineStore.get(), input, {
      now: Date.now(),
      quote,
      prices: pricesFromQuotes(quoteStore.record()),
    });
    if (r.error) return { order: null, error: r.error };
    commit(r);
    return { order: r.order, error: null };
  }

  async modifyOrder(orderId: string, changes: ModifyChanges): Promise<{ order: Order | null; error: string | null }> {
    const o = engineStore.get().orders.find((x) => x.id === orderId);
    if (!o) return { order: null, error: 'Order not found.' };
    const quote = await this.quoteFor(o.instrument);
    const r = modifyOrder(engineStore.get(), orderId, changes, {
      now: Date.now(),
      quote,
      prices: pricesFromQuotes(quoteStore.record()),
    });
    if (r.error) return { order: r.order, error: r.error };
    commit(r);
    return { order: r.order, error: null };
  }

  cancelOrder(orderId: string) {
    commit(cancelOrder(engineStore.get(), orderId, Date.now()));
  }

  addToWatchlist(inst: Instrument) {
    engineStore.set(addToWatchlist(engineStore.get(), inst));
    if (!quoteStore.get(inst.symbol)) void this.fetchOne(inst);
  }

  removeFromWatchlist(symbol: string) {
    engineStore.set(removeFromWatchlist(engineStore.get(), symbol));
  }

  moveInWatchlist(symbol: string, delta: -1 | 1) {
    engineStore.set(moveInWatchlist(engineStore.get(), symbol, delta));
  }

  updateSettings(patch: Partial<Settings>) {
    engineStore.set(updateSettings(engineStore.get(), patch));
    if (patch.refreshSeconds) this.schedule();
  }

  resetAccount(startingCapital: number) {
    engineStore.set(resetAccount(engineStore.get(), Date.now(), startingCapital));
    engineStore.setMeta({ lastEvalAt: Date.now() });
    toastStore.push([
      { id: `reset-${Date.now()}`, kind: 'info', title: 'Account reset', body: `Starting fresh with ₹${startingCapital.toLocaleString('en-IN')}` },
    ]);
  }

  instrumentFor(symbol: string): Instrument {
    const s = engineStore.get();
    return (
      s.watchlist.find((i) => i.symbol === symbol) ??
      Object.values(s.positions).find((p) => p.instrument.symbol === symbol)?.instrument ??
      s.holdings[symbol]?.instrument ??
      s.orders.find((o) => o.instrument.symbol === symbol)?.instrument ??
      this.focus.get(symbol)?.inst ??
      instrumentFromSymbol(symbol, quoteStore.get(symbol)?.name)
    );
  }
}

/** True if any weekday session (09:15–15:30 IST) overlaps [from, to]. */
export function gapTouchesSession(from: number, to: number): boolean {
  const last = istDayKey(to);
  for (let day = istDayKey(from), guard = 0; day <= last && guard < 30; day = addDays(day, 1), guard++) {
    const open = istTimestamp(day, SESSION.open);
    if (!isWeekday(open)) continue;
    const close = istTimestamp(day, SESSION.close);
    if (from < close && to > open) return true;
  }
  return false;
}

export const controller = new MarketController();

export type MarketStatus = 'open' | 'pre-open' | 'closed' | 'weekend' | 'holiday';

export function marketStatus(now: number, benchmark: Quote | undefined): MarketStatus {
  const phase = clockPhase(now);
  if (phase === 'weekend') return 'weekend';
  const today = istDayKey(now);
  const benchmarkStale = !!benchmark && istDayKey(benchmark.time) !== today && now - benchmark.fetchedAt < 5 * 60_000;
  if (phase === 'open') {
    const m = istParts(now).minuteOfDay;
    if (benchmarkStale && m >= SESSION.open + 10) return 'holiday';
    return 'open';
  }
  if (phase === 'pre-open') return 'pre-open';
  if (phase === 'post-market' && benchmarkStale) return 'holiday';
  return 'closed';
}

/** Re-evaluates market status every 15 s and when the benchmark quote changes. */
export function useMarketStatus(): MarketStatus {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  const [benchmark, setBenchmark] = useState<Quote | undefined>(quoteStore.get(BENCHMARK));
  useEffect(() => {
    const unsubscribe = quoteStore.subscribe(() => setBenchmark(quoteStore.get(BENCHMARK)));
    return () => {
      unsubscribe();
    };
  }, []);
  return marketStatus(now, benchmark);
}
