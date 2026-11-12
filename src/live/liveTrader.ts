/**
 * Live mode: while the app is open in market hours, watches ~40 stocks on 1-minute bars,
 * reads news, and calls Claude for a short decision when something happens or a check-in
 * is due. Every order still goes through the engine and the coded risk limits.
 */
import { runAgent } from '../ai/agent';
import { aiLock } from '../ai/lock';
import { makeEnv, marketStatusText } from '../ai/runner';
import { aiStore } from '../ai/store';
import type { AiRun } from '../ai/types';
import { mapLimit } from '../data/http';
import { BENCHMARK, INDICES, STRATEGY_UNIVERSE } from '../data/instruments';
import { yahooCandles } from '../data/yahoo';
import { activeGttFor, computeFunds, pricesFromQuotes } from '../engine/engine';
import { accountSummary } from '../engine/selectors';
import type { EngineState, Instrument, Quote } from '../engine/types';
import { formatIstTime, istDayKey, istParts, parseHHMM } from '../lib/time';
import { setKeepAwake } from '../native/keepAwake';
import { controller, marketStatus } from '../state/controller';
import { engineStore } from '../state/engineStore';
import { quoteStore } from '../state/quoteStore';
import { toastStore } from '../state/uiStores';
import { strategyStore } from '../strategies/store';
import { applyTick, emptyIntraday, mergeCandles, type IntradayState } from './bars';
import { matchContext, mergeNews, NewsPoller, toNewsItems, type MatchContext, type NewsItem } from './news';
import { buildLiveSystemPrompt, buildLiveUserPrompt } from './prompt';
import { intradayLossLimitHit, type LiveSettings } from './risk';
import { SIGNAL_LABEL, detectSignals, type DayContext } from './signals';
import { aiIntradayStats, type IntradayStats } from './stats';
import {
  MAX_EVENTS_PER_CALL,
  decideTrigger,
  isStale,
  liveUniverse,
  newsEvents,
  previousDayContext,
  signalPriority,
} from './policy';
import { liveStore, spendOn, type LiveEvent } from './store';
import { LIVE_TOOLS, LiveSessionTools, type LiveContext } from './tools';

const MINUTE = 60_000;
const NEWS_SYMBOLS_WINDOW_MS = 90 * MINUTE;
const CANDLE_REFRESH_MS = 5 * MINUTE;
const CANDLE_BATCH = 8;
const SIGNAL_COOLDOWN_MS = 30 * MINUTE;

const FATAL = /API key was rejected|out of credits|isn’t allowed/i;

/* ---------------- the trader ---------------- */

class LiveTrader {
  private day = '';
  private bars = new Map<string, IntradayState>();
  private ctx = new Map<string, DayContext | null>();
  private seeded = new Set<string>();
  private lastCandles = new Map<string, number>();
  private lastTick = new Map<string, number>();
  private cooldown = new Map<string, number>();
  private refreshing = false;
  private universe: Instrument[] = [];
  private universeAt = 0;
  private poller = new NewsPoller();
  private firstPoll = true;
  private match: MatchContext | null = null;
  private matchKey = '';
  private thinking = false;
  private abort: AbortController | null = null;
  private failures = 0;
  private backoffUntil = 0;
  private blocked: string | null = null;
  private started = false;
  private manualRequested = false;

  /** Wires Live mode into the price loop. Safe to call more than once. */
  start() {
    if (this.started) return;
    this.started = true;
    controller.setExtraInstruments(() => (liveStore.get().armed ? this.universe : []));
    controller.addAfterCycle(() => void this.onCycle());
    if (liveStore.get().armed) setKeepAwake(liveStore.get().settings.keepAwake);
  }

  isThinking(): boolean {
    return this.thinking;
  }

  async arm(): Promise<string | null> {
    await liveStore.load();
    await aiStore.load();
    if (!aiStore.get().hasKey) return 'Add your Claude API key in AI settings first.';
    this.blocked = null;
    this.failures = 0;
    this.backoffUntil = 0;
    liveStore.setArmed(true);
    this.universeAt = 0;
    void controller.refresh();
    return null;
  }

  disarm() {
    liveStore.setArmed(false);
    this.abort?.abort();
    setKeepAwake(false);
    liveStore.setRuntime({ nextCheckInAt: null });
  }

  /** Asks for a decision at the next price refresh, ignoring the gap and pacing (not the budget). */
  requestDecision(): string | null {
    const s = liveStore.get();
    if (!s.armed) return 'Start Live mode first.';
    if (this.thinking) return 'Already deciding.';
    if (marketStatus(Date.now(), quoteStore.get(BENCHMARK)) !== 'open') return 'The market is closed.';
    if (spendOn(s, istDayKey(Date.now())) >= s.settings.dailyBudgetUsd) return 'Today’s live budget is used up. Raise it in Live settings.';
    this.manualRequested = true;
    void controller.refresh();
    return null;
  }

  stopThinking() {
    this.abort?.abort();
  }

  private resetDay(day: string) {
    this.day = day;
    this.bars.clear();
    this.ctx.clear();
    this.seeded.clear();
    this.lastCandles.clear();
    this.lastTick.clear();
    this.cooldown.clear();
  }

  private stats(): IntradayStats {
    return aiIntradayStats(engineStore.get(), quoteStore.record(), liveStore.get().runs, Date.now());
  }

  private heldDirection(state: EngineState, symbol: string): { intraday: 'long' | 'short' | null; swing: boolean } {
    const p = state.positions[`${symbol}|MIS`];
    const intraday = p && p.ai && p.netQty !== 0 ? (p.netQty > 0 ? 'long' : 'short') : null;
    const swing = !!state.holdings[symbol]?.ai || !!(state.positions[`${symbol}|CNC`]?.ai && (state.positions[`${symbol}|CNC`]?.netQty ?? 0) > 0);
    return { intraday, swing };
  }

  private refreshUniverse(now: number) {
    if (now - this.universeAt < 60_000 && this.universe.length) return;
    const state = engineStore.get();
    const newsSymbols: string[] = [];
    for (const n of liveStore.get().news) {
      if (now - n.publishedAt > NEWS_SYMBOLS_WINDOW_MS) break;
      if (n.important) for (const s of n.symbols) if (!newsSymbols.includes(s)) newsSymbols.push(s);
      if (newsSymbols.length >= 10) break;
    }
    this.universe = liveUniverse({
      state,
      scan: strategyStore.get().scan,
      newsSymbols,
      instrumentFor: (s) => controller.instrumentFor(s),
    });
    this.universeAt = now;
    liveStore.setRuntime({ watching: this.universe.length });
    // Names to match news against: the whole strategy universe plus anything the user follows.
    const pool = new Map<string, Instrument>();
    for (const i of STRATEGY_UNIVERSE) pool.set(i.symbol, i);
    for (const i of state.watchlist) pool.set(i.symbol, i);
    for (const h of Object.values(state.holdings)) pool.set(h.instrument.symbol, h.instrument);
    const key = [...pool.keys()].sort().join(',');
    if (key !== this.matchKey) {
      this.match = matchContext([...pool.values()]);
      this.matchKey = key;
    }
  }

  /** Loads today's 1-minute bars (and, once a day, the previous day's levels) for one symbol. */
  private async loadCandles(symbol: string): Promise<void> {
    const today = this.day;
    const tasks: Promise<unknown>[] = [
      yahooCandles(symbol, '1d', '1m').then((r) => {
        if (this.day !== today) return;
        const cur = this.bars.get(symbol) ?? emptyIntraday(today);
        this.bars.set(symbol, mergeCandles(cur, r.candles));
        this.seeded.add(symbol);
      }),
    ];
    if (!this.ctx.has(symbol)) {
      tasks.push(
        yahooCandles(symbol, '5d', '1d').then((r) => {
          if (this.day === today) this.ctx.set(symbol, previousDayContext(r.candles, today));
        }),
      );
    }
    await Promise.all(tasks);
    this.lastCandles.set(symbol, Date.now());
  }

  /** Refreshes the 1-minute candles that are due; returns the symbols that got new bars. */
  private async refreshCandles(now: number): Promise<string[]> {
    if (this.refreshing) return [];
    const symbols = [BENCHMARK, ...this.universe.map((i) => i.symbol)];
    const due = symbols
      .filter((s) => now - (this.lastCandles.get(s) ?? 0) >= (this.seeded.has(s) ? CANDLE_REFRESH_MS : 60_000))
      .sort((a, b) => Number(this.seeded.has(a)) - Number(this.seeded.has(b)) || (this.lastCandles.get(a) ?? 0) - (this.lastCandles.get(b) ?? 0))
      .slice(0, CANDLE_BATCH);
    if (due.length === 0) return [];
    this.refreshing = true;
    const done: string[] = [];
    try {
      await mapLimit(due, 3, async (s) => {
        try {
          await this.loadCandles(s);
          done.push(s);
        } catch {
          // Retried after a minute; ticks keep building bars meanwhile.
          this.lastCandles.set(s, Date.now());
        }
      });
    } finally {
      this.refreshing = false;
    }
    return done;
  }

  private applyTicks(quotes: Record<string, Quote>): Set<string> {
    const dirty = new Set<string>();
    for (const s of [BENCHMARK, ...this.universe.map((i) => i.symbol)]) {
      const q = quotes[s];
      if (!q || q.fetchedAt <= (this.lastTick.get(s) ?? 0)) continue;
      this.lastTick.set(s, q.fetchedAt);
      const cur = this.bars.get(s) ?? emptyIntraday(this.day);
      const next = applyTick(cur, q.ltp, q.volume, q.time > 0 ? Math.min(q.time, q.fetchedAt) : q.fetchedAt);
      if (next !== cur) {
        this.bars.set(s, next);
        dirty.add(s);
      }
    }
    return dirty;
  }

  private scanSignals(symbols: Iterable<string>, now: number): LiveEvent[] {
    const state = engineStore.get();
    const out: LiveEvent[] = [];
    for (const s of symbols) {
      if (s.startsWith('^') || !this.seeded.has(s)) continue;
      const st = this.bars.get(s);
      if (!st) continue;
      for (const sig of detectSignals(s, st, this.ctx.get(s) ?? null, now)) {
        const key = `${s}|${sig.kind}`;
        const cool = sig.kind === 'gap_up' || sig.kind === 'gap_down' ? 24 * 60 * MINUTE : SIGNAL_COOLDOWN_MS;
        if (now - (this.cooldown.get(key) ?? -Infinity) < cool) continue;
        this.cooldown.set(key, now);
        out.push({
          id: `s-${s}-${sig.kind}-${now}`,
          t: now,
          kind: 'signal',
          symbol: s,
          title: SIGNAL_LABEL[sig.kind],
          detail: `${sig.message} · strength ${sig.strength}${sig.paper ? ` · ${sig.paper}` : ''}`,
          direction: sig.direction,
          priority: signalPriority(sig, this.heldDirection(state, s)),
          link: null,
          runId: null,
        });
      }
    }
    return out;
  }

  private async pollNews(now: number) {
    const s = liveStore.get().settings;
    const results = await this.poller.poll({ pulse: s.newsPulse, nse: s.newsNse }, now);
    liveStore.setRuntime({
      feeds: {
        pulse: { lastOkAt: this.poller.status.pulse.lastOkAt, lastError: this.poller.status.pulse.lastError },
        nse: { lastOkAt: this.poller.status.nse.lastOkAt, lastError: this.poller.status.nse.lastError },
      },
    });
    if (!this.match) return;
    const firstRun = this.firstPoll;
    let list = liveStore.get().news;
    const fresh: NewsItem[] = [];
    const added: string[] = [];
    for (const r of results) {
      const merged = mergeNews(list, toNewsItems(r.source, r.items, this.match, now), liveStore.seenIds(), now, firstRun);
      list = merged.list;
      fresh.push(...merged.fresh);
      added.push(...merged.added.map((n) => n.id));
    }
    if (results.length) this.firstPoll = false;
    if (added.length) liveStore.addNews(list, added);
    const state = engineStore.get();
    const held = (sym: string) => {
      const h = this.heldDirection(state, sym);
      return h.intraday !== null || h.swing;
    };
    const events = newsEvents(fresh, held, now);
    if (events.length) {
      liveStore.addEvents(events);
      // Stocks in the news join the watch list at the next refresh.
      if (events.some((e) => e.symbol && !this.universe.some((i) => i.symbol === e.symbol))) this.universeAt = 0;
    }
  }

  private async onCycle() {
    const s = liveStore.get();
    if (!s.loaded || !s.armed || !engineStore.isReady()) return;
    const now = Date.now();
    const status = marketStatus(now, quoteStore.get(BENCHMARK));
    setKeepAwake(s.settings.keepAwake && (status === 'open' || status === 'pre-open'));
    const today = istDayKey(now);
    if (today !== this.day) this.resetDay(today);
    this.refreshUniverse(now);

    // News is read whenever Live mode is on, so overnight and pre-open news is ready for the first decision.
    void this.pollNews(now).catch(() => undefined);

    if (status !== 'open') {
      const text =
        status === 'pre-open'
          ? 'Pre-open. Watching from 9:15 AM'
          : status === 'weekend'
            ? 'Weekend. Live resumes at Monday’s open'
            : status === 'holiday'
              ? 'Market holiday. Live resumes at the next open'
              : 'Market closed. Live resumes at 9:15 AM on the next trading day';
      liveStore.setPhase('waiting', text);
      return;
    }

    const dirty = this.applyTicks(quoteStore.record());
    void this.refreshCandles(now)
      .then((symbols) => {
        // Freshly merged candles (with real volume) can complete a signal on their own.
        if (symbols.length && liveStore.get().armed) liveStore.addEvents(this.scanSignals(symbols, Date.now()));
      })
      .catch(() => undefined);
    liveStore.addEvents(this.scanSignals(dirty, now));

    if (this.thinking) return;
    if (this.blocked) {
      liveStore.setPhase('paused', this.blocked);
      return;
    }
    if (now < this.backoffUntil) {
      liveStore.setPhase('paused', `Claude unavailable; retrying after ${formatIstTime(this.backoffUntil, false)}`);
      return;
    }
    if (aiLock.holder() !== null) {
      liveStore.setPhase('watching', 'Waiting for the scheduled AI session to finish');
      return;
    }
    if (this.seeded.size < Math.min(5, this.universe.length)) {
      liveStore.setPhase('starting', `Loading today’s charts (${this.seeded.size} of ${this.universe.length})`);
      return;
    }

    const ai = aiStore.get();
    if (!ai.hasKey) {
      liveStore.setPhase('paused', 'Add your Claude API key in AI settings');
      return;
    }
    const state = engineStore.get();
    const quotes = quoteStore.record();
    const stats = this.stats();
    const equity = accountSummary(state, quotes).equity;
    const minute = istParts(now).minuteOfDay;
    const st = s.settings;
    const canOpenNew =
      minute < parseHHMM(st.lastEntry) &&
      stats.tradesToday < st.maxTradesPerDay &&
      stats.openPositions < st.maxPositions &&
      !intradayLossLimitHit(stats.pnlToday, equity, st);
    const pending = s.events.filter((e) => e.runId === null && now - e.t < 18 * 60 * MINUTE);
    const spent = spendOn(s, today);

    if (this.manualRequested) {
      this.manualRequested = false;
      if (spent < st.dailyBudgetUsd) {
        await this.decide('manual', pending.filter((e) => !isStale(e, now)).slice(0, MAX_EVENTS_PER_CALL), stats);
        return;
      }
    }
    const decision = decideTrigger({
      now,
      minuteOfDay: minute,
      settings: st,
      squareOffMinute: parseHHMM(state.settings.squareOffTime),
      lastDecisionAt: s.lastDecisionAt,
      spentToday: spent,
      pending,
      openIntraday: stats.openPositions,
      canOpenNew,
    });
    if (!decision.run) {
      liveStore.setRuntime({ nextCheckInAt: decision.nextCheckInAt });
      liveStore.setPhase('watching', decision.why);
      return;
    }
    await this.decide(decision.reason, decision.events, stats);
  }

  private liveContext(settings: LiveSettings): LiveContext {
    return {
      settings,
      stats: () => this.stats(),
      intraday: async (symbol) => {
        if (!this.seeded.has(symbol)) await this.loadCandles(symbol).catch(() => undefined);
        const st = this.bars.get(symbol);
        return st ? { state: st, ctx: this.ctx.get(symbol) ?? null } : null;
      },
      newsFor: (symbol) => liveStore.get().news.filter((n) => n.symbols.includes(symbol) && Date.now() - n.publishedAt < 24 * 60 * MINUTE),
      signalsFor: (symbol) => liveStore.get().events.filter((e) => e.kind === 'signal' && e.symbol === symbol && istDayKey(e.t) === this.day),
    };
  }

  private indexContext() {
    const quotes = quoteStore.record();
    return INDICES.map((i) => {
      const q = quotes[i.symbol];
      const bars = this.bars.get(i.symbol)?.bars ?? [];
      const open = bars[0]?.o ?? q?.open ?? null;
      return {
        name: i.tradingSymbol,
        level: q?.ltp ?? null,
        changePct: q && q.prevClose ? Math.round((q.ltp / q.prevClose - 1) * 10_000) / 100 : null,
        fromOpenPct: q && open ? Math.round((q.ltp / open - 1) * 10_000) / 100 : null,
      };
    });
  }

  private async decide(reason: 'events' | 'check-in' | 'manual', events: LiveEvent[], stats: IntradayStats) {
    if (!aiLock.tryAcquire('live')) return;
    this.thinking = true;
    const startedAt = Date.now();
    liveStore.setPhase('thinking', reason === 'check-in' ? 'Check-in: reviewing positions and the market' : reason === 'manual' ? 'Deciding now' : `Looking at ${events.length} new event${events.length === 1 ? '' : 's'}`);
    let run: AiRun | null = null;
    try {
      const apiKey = await aiStore.getApiKey();
      if (!apiKey) {
        this.blocked = 'Add your Claude API key in AI settings';
        return;
      }
      const ai = aiStore.get().settings;
      const ls = liveStore.get();
      const st = ls.settings;
      const env = makeEnv();
      const state = engineStore.get();
      const quotes = quoteStore.record();
      const sum = accountSummary(state, quotes);
      const funds = computeFunds(state, pricesFromQuotes(quotes));
      const intradayExits: Record<string, { stop: number | null; target: number | null }> = {};
      for (const p of stats.positions) {
        const g = activeGttFor(state, p.symbol, 'MIS')[0];
        intradayExits[p.symbol] = { stop: g?.stopPrice ?? null, target: g?.targetPrice ?? null };
      }
      const swing = Object.values(state.holdings)
        .filter((h) => h.ai && h.qty > 0)
        .map((h) => {
          const ltp = quotes[h.instrument.symbol]?.ltp ?? null;
          const g = activeGttFor(state, h.instrument.symbol, 'CNC').find((x) => x.source === 'AI');
          return {
            symbol: h.instrument.symbol,
            qty: h.qty,
            avg: h.avgPrice,
            ltp,
            pnlPct: ltp !== null ? Math.round((ltp / h.avgPrice - 1) * 10_000) / 100 : null,
            stop: g?.stopPrice ?? null,
            target: g?.targetPrice ?? null,
          };
        });
      const eventIds = new Set(events.map((e) => e.id));
      const earlier = ls.events
        .filter((e) => !eventIds.has(e.id) && e.runId !== null && startedAt - e.t < 45 * MINUTE && e.priority >= 2)
        .slice(0, 8);
      const macro = ls.news.filter((n) => n.macro && startedAt - n.publishedAt < 2 * 60 * MINUTE).slice(0, 5);
      const decisions = ls.runs
        .filter((r) => r.day === this.day && r.status !== 'running')
        .slice(0, 6)
        .map((r) => ({
          t: r.startedAt,
          text:
            [
              ...r.decisions
                .filter((d) => d.outcome !== 'rejected')
                .map((d) => `${d.action === 'UPDATE_EXIT' ? 'moved exit on' : d.intent === 'close' ? 'closed' : d.direction === 'short' ? 'shorted' : 'bought'} ${d.symbol}${d.product === 'CNC' ? ' (swing)' : ''}`),
              r.summary ?? '',
            ]
              .filter(Boolean)
              .join('; ')
              .slice(0, 300) || 'no action',
        }));
      const ctx = this.liveContext(st);
      const system = buildLiveSystemPrompt(st, ai, state.settings.squareOffTime, state.settings.misLeverage);
      const user = buildLiveUserPrompt({
        now: startedAt,
        reason,
        marketStatus: marketStatusText(startedAt),
        indices: this.indexContext(),
        account: { equity: sum.equity, available: funds.available },
        settings: st,
        stats,
        intradayExits,
        swing,
        events,
        earlier,
        macro,
        decisions,
        watching: this.universe.length,
        spentToday: spendOn(ls, this.day),
      });
      const abort = new AbortController();
      this.abort = abort;
      run = await runAgent({
        apiKey,
        settings: ai,
        env,
        trigger: 'live',
        slot: null,
        previous: null,
        signal: abort.signal,
        onUpdate: (r) => liveStore.setRuntime({ thinking: r }),
        mode: {
          model: st.model,
          system,
          user,
          clientTools: LIVE_TOOLS,
          makeExecutor: (addStep) => new LiveSessionTools(env, ai, addStep, ctx),
          maxRequests: 10,
          maxTokens: 6000,
          maxSearches: 2,
          maxFetches: 2,
          costCapUsd: Math.max(0.1, Math.min(0.75, st.dailyBudgetUsd / 4)),
        },
      });
      liveStore.upsertRun(run);
      liveStore.addSpend(run.day, run.usage.costUsd);
      // Events go back in the queue when the call failed, so the next attempt still sees them.
      if (run.status !== 'failed') liveStore.markEventsSeen(events.map((e) => e.id), run.id);
      if (run.status === 'failed') {
        const msg = run.error ?? 'Live decision failed';
        if (FATAL.test(msg)) {
          this.blocked = msg;
          toastStore.push([{ id: `live-${run.id}`, kind: 'reject', title: 'Live mode paused', body: msg }]);
        } else {
          this.failures++;
          this.backoffUntil = Date.now() + Math.min(15, 2 ** this.failures) * MINUTE;
        }
      } else {
        this.failures = 0;
        const trades = run.decisions.filter((d) => d.outcome !== 'rejected' && d.action !== 'UPDATE_EXIT').length;
        if (trades === 0 && run.decisions.some((d) => d.outcome === 'updated')) {
          toastStore.push([{ id: `live-${run.id}`, kind: 'info', title: 'Live AI moved an exit', body: run.summary?.slice(0, 140) ?? '' }]);
        }
      }
    } catch (e) {
      this.failures++;
      this.backoffUntil = Date.now() + Math.min(15, 2 ** this.failures) * MINUTE;
      console.error('[PaperDalal] Live decision failed:', e instanceof Error ? e.message : e);
    } finally {
      this.thinking = false;
      this.abort = null;
      liveStore.setRuntime({ thinking: null });
      liveStore.setLastDecisionAt(startedAt);
      aiLock.release('live');
      await liveStore.flush();
      await engineStore.flush();
      if (run) liveStore.setPhase('watching', run.summary ? 'Decision made · watching' : 'Watching for setups');
    }
  }
}

export const liveTrader = new LiveTrader();
