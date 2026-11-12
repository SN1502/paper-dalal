import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runAgent } from '../src/ai/agent';
import type { AgentEnv } from '../src/ai/tools';
import { DEFAULT_AI_SETTINGS, type AiRun } from '../src/ai/types';
import { STRATEGY_UNIVERSE, instrumentFromSymbol } from '../src/data/instruments';
import { DEFAULT_SETTINGS, createInitialState, placeOrder, processQuotes, updateGtt } from '../src/engine/engine';
import type { Candle, EngineState, Quote } from '../src/engine/types';
import { istTimestamp, parseHHMM } from '../src/lib/time';
import { applyTick, emptyIntraday } from '../src/live/bars';
import { NewsPoller, matchContext, mergeNews, toNewsItems, type NewsItem } from '../src/live/news';
import { decideTrigger, liveUniverse, newsEvents, paceAllows, previousDayContext, signalPriority, type TriggerInput } from '../src/live/policy';
import { buildLiveSystemPrompt, buildLiveUserPrompt } from '../src/live/prompt';
import { DEFAULT_LIVE_SETTINGS, type LiveSettings } from '../src/live/risk';
import type { LiveSignal } from '../src/live/signals';
import { aiIntradayStats } from '../src/live/stats';
import type { LiveEvent } from '../src/live/store';
import { LIVE_TOOLS, LiveSessionTools, type LiveContext } from '../src/live/tools';

const MON = '2026-11-02';
const at = (hhmm: string) => istTimestamp(MON, parseHHMM(hhmm));
const NOW = at('10:05');

function quote(symbol: string, ltp: number): Quote {
  return {
    symbol,
    ltp,
    prevClose: ltp * 0.99,
    open: ltp * 0.995,
    high: ltp * 1.005,
    low: ltp * 0.99,
    volume: 1e6,
    week52High: ltp * 1.2,
    week52Low: ltp * 0.8,
    time: NOW - 5000,
    fetchedAt: NOW - 1000,
    source: 'yahoo',
    name: symbol,
  };
}

function candles(price: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 300; i++) {
    const c = price * (0.9 + (0.1 * i) / 299) * (1 + 0.01 * Math.sin(i / 3));
    out.push({ t: NOW - (300 - i) * 86_400_000, o: c, h: c * 1.01, l: c * 0.99, c, v: Math.round(3e9 / price) });
  }
  out[out.length - 1].c = price;
  return out;
}

function makeWorld() {
  let state: EngineState = createInitialState(at('09:00'), DEFAULT_SETTINGS, []);
  const prices: Record<string, number> = { 'INFY.NS': 1500, 'TCS.NS': 3400, 'PENNY.NS': 40, '^NSEI': 25000, '^BSESN': 82000, '^NSEBANK': 56000 };
  const quotes = () => Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, quote(k, v)]));
  const env: AgentEnv = {
    now: () => NOW,
    getState: () => state,
    quotes,
    instrumentFor: (s) => instrumentFromSymbol(s),
    getQuote: async (inst) => (prices[inst.symbol] ? quote(inst.symbol, prices[inst.symbol]) : null),
    getDailyCandles: async (s) => candles(prices[s] ?? 100),
    search: async () => [],
    placeOrder: async (input) => {
      const r = placeOrder(state, input, { now: NOW, quote: quote(input.instrument.symbol, prices[input.instrument.symbol]), prices });
      if (!r.error) state = r.state;
      return { order: r.order, error: r.error };
    },
    updateGtt: (id, patch) => {
      const r = updateGtt(state, id, patch, NOW, prices[state.gtts.find((g) => g.id === id)?.instrument.symbol ?? ''] ?? null);
      if (!r.error) state = r.state;
      return { error: r.error };
    },
    marketStatus: () => 'open (live prices)',
    getScan: async () => null,
    saveFundamentals: () => undefined,
  };
  return {
    env,
    prices,
    quotes,
    getState: () => state,
    setState: (s: EngineState) => {
      state = s;
    },
  };
}

function liveCtx(world: ReturnType<typeof makeWorld>, settings: LiveSettings = DEFAULT_LIVE_SETTINGS, runs: AiRun[] = []): LiveContext {
  let bars = emptyIntraday(MON);
  for (let m = 0; m < 50; m++) bars = applyTick(bars, 1490 + m * 0.2, 10_000 + m * 5000, at('09:15') + m * 60_000 + 1000);
  return {
    settings,
    stats: () => aiIntradayStats(world.getState(), world.quotes(), runs, NOW),
    intraday: async () => ({ state: bars, ctx: { prevHigh: 1505, prevLow: 1470, prevClose: 1485 } }),
    newsFor: () => [],
    signalsFor: () => [],
  };
}

const noop = () => undefined;
const parse = (s: string) => JSON.parse(s);

describe('live intraday tools', () => {
  it('opens an intraday short with a bracket, trails its stop and closes it', async () => {
    const w = makeWorld();
    const tools = new LiveSessionTools(w.env, DEFAULT_AI_SETTINGS, noop, liveCtx(w));

    const snap = parse((await tools.execute('get_intraday_snapshot', { symbol: 'INFY' })).content);
    assert.equal(snap.symbol, 'INFY');
    assert.ok(snap.intraday.vwap > 0);
    assert.deepEqual(snap.intraday.pivots_from_previous_day.pivot, 1486.67);

    const out = await tools.execute('open_intraday_trade', { symbol: 'INFY', direction: 'short', stop_loss: 1515, target: 1470, thesis: 'Weak guidance.', conviction: 3 });
    assert.equal(out.isError, false, out.content);
    const res = parse(out.content);
    // Smallest of: 0.5% risk (₹5,000 / ₹15 = 333), 20% notional (₹2L / 1,500 = 133), margin.
    assert.equal(res.qty, 133);
    let state = w.getState();
    assert.equal(state.positions['INFY.NS|MIS'].netQty, -133);
    assert.equal(state.positions['INFY.NS|MIS'].ai, true);
    const g = state.gtts.find((x) => x.status === 'ACTIVE');
    assert.ok(g);
    assert.equal(g.product, 'MIS');
    assert.equal(g.exitSide, 'BUY');
    assert.equal(g.stopPrice, 1515);
    assert.equal(tools.decisions[0].direction, 'short');
    assert.equal(tools.decisions[0].intent, 'open');

    // Stops only tighten: down for a short.
    const widen = await tools.execute('update_exit', { symbol: 'INFY', product: 'intraday', stop_loss: 1520, reason: 'x' });
    assert.equal(widen.isError, true);
    assert.match(parse(widen.content).error, /tightened/);
    const tighten = await tools.execute('update_exit', { symbol: 'INFY', product: 'intraday', stop_loss: 1508, reason: 'Trail' });
    assert.equal(tighten.isError, false, tighten.content);
    assert.equal(w.getState().gtts.find((x) => x.status === 'ACTIVE')?.stopPrice, 1508);

    // One position per stock.
    const again = await tools.execute('open_intraday_trade', { symbol: 'INFY', direction: 'short', stop_loss: 1515, target: 1470, thesis: 'x' });
    assert.match(parse(again.content).reason, /Already in an intraday position/);

    const close = parse((await tools.execute('close_position', { symbol: 'INFY', product: 'intraday', reason: 'Target near' })).content);
    assert.equal(close.status, 'filled');
    state = w.getState();
    assert.equal(state.positions['INFY.NS|MIS'].netQty, 0);
    // The exit ends once nothing is left to protect.
    const after = processQuotes(state, w.quotes(), NOW + 1000).state;
    assert.equal(after.gtts.filter((x) => x.status === 'ACTIVE').length, 0);
    assert.equal(tools.decisions[tools.decisions.length - 1].intent, 'close');
  });

  it('enforces the intraday limits in code', async () => {
    const w = makeWorld();
    const noShort = new LiveSessionTools(w.env, DEFAULT_AI_SETTINGS, noop, liveCtx(w, { ...DEFAULT_LIVE_SETTINGS, allowShort: false }));
    assert.match(parse((await noShort.execute('open_intraday_trade', { symbol: 'INFY', direction: 'short', stop_loss: 1515, target: 1470, thesis: 'x' })).content).reason, /switched off/);

    const tools = new LiveSessionTools(w.env, DEFAULT_AI_SETTINGS, noop, liveCtx(w));
    assert.match(parse((await tools.execute('open_intraday_trade', { symbol: 'INFY', direction: 'long', stop_loss: 1400, target: 1700, thesis: 'x' })).content).reason, /within 3%/);
    assert.match(parse((await tools.execute('open_intraday_trade', { symbol: 'INFY', direction: 'long', stop_loss: 1490, target: 1505, thesis: 'x' })).content).reason, /Reward-to-risk/);
    assert.match(parse((await tools.execute('open_intraday_trade', { symbol: 'PENNY', direction: 'long', stop_loss: 39, target: 43, thesis: 'x' })).content).reason, /at least ₹50/);

    const late = new LiveSessionTools({ ...w.env, now: () => at('14:50') }, DEFAULT_AI_SETTINGS, noop, liveCtx(w));
    assert.match(parse((await late.execute('open_intraday_trade', { symbol: 'INFY', direction: 'long', stop_loss: 1485, target: 1530, thesis: 'x' })).content).reason, /after 14:45/);

    // The user's own intraday position is off limits.
    const r = placeOrder(w.getState(), { instrument: instrumentFromSymbol('TCS.NS'), side: 'BUY', product: 'MIS', type: 'MARKET', qty: 5, price: null, triggerPrice: null }, { now: NOW, quote: quote('TCS.NS', 3400), prices: w.prices });
    w.setState(r.state);
    assert.match(parse((await tools.execute('close_position', { symbol: 'TCS', product: 'intraday', reason: 'x' })).content).error, /belongs to the user/);
    assert.ok(tools.decisions.every((d) => d.outcome === 'rejected'));
  });

  it('counts AI intraday trades, open positions and P&L for the limits', async () => {
    const w = makeWorld();
    const tools = new LiveSessionTools(w.env, DEFAULT_AI_SETTINGS, noop, liveCtx(w));
    await tools.execute('open_intraday_trade', { symbol: 'INFY', direction: 'long', stop_loss: 1485, target: 1530, thesis: 'ORB' });
    const run = { day: MON, decisions: tools.decisions } as unknown as AiRun;
    w.prices['INFY.NS'] = 1510;
    const st = aiIntradayStats(w.getState(), w.quotes(), [run], NOW);
    assert.equal(st.tradesToday, 1);
    assert.equal(st.openPositions, 1);
    assert.equal(st.positions[0].direction, 'long');
    assert.ok(st.pnlToday > 0);
    assert.equal(st.swingBuysToday, 0);
  });
});

describe('live decision through the agent loop', () => {
  it('uses the live prompt, tools and limits', async () => {
    const w = makeWorld();
    const requests: any[] = [];
    const replies = [
      [{ type: 'tool_use', id: 'a', name: 'get_intraday_snapshot', input: { symbol: 'INFY' } }],
      [{ type: 'tool_use', id: 'b', name: 'open_intraday_trade', input: { symbol: 'INFY', direction: 'long', stop_loss: 1485, target: 1530, thesis: 'Above VWAP on news (§3.14).' } }],
      [{ type: 'tool_use', id: 'c', name: 'finish', input: { summary: 'Bought INFY on the breakout.' } }],
    ];
    const f = (async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      const content = replies.shift();
      return new Response(
        JSON.stringify({ id: 'm', model: 'claude-haiku-5-5', content, stop_reason: 'tool_use', usage: { input_tokens: 2000, output_tokens: 150 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const ctx = liveCtx(w);
    const system = buildLiveSystemPrompt(DEFAULT_LIVE_SETTINGS, DEFAULT_AI_SETTINGS, '15:20', 5);
    const run = await runAgent({
      apiKey: 'k',
      settings: DEFAULT_AI_SETTINGS,
      env: w.env,
      trigger: 'live',
      slot: null,
      previous: null,
      fetchImpl: f,
      mode: {
        model: 'claude-haiku-5-5',
        system,
        user: 'Live decision test',
        clientTools: LIVE_TOOLS,
        makeExecutor: (add) => new LiveSessionTools(w.env, DEFAULT_AI_SETTINGS, add, ctx),
        maxRequests: 10,
        maxTokens: 6000,
        maxSearches: 2,
        maxFetches: 1,
        costCapUsd: 0.5,
      },
    });
    assert.equal(run.status, 'completed', run.error ?? '');
    assert.equal(run.trigger, 'live');
    assert.equal(run.summary, 'Bought INFY on the breakout.');
    assert.equal(run.decisions[0].product, 'MIS');
    const first = requests[0];
    assert.equal(first.model, 'claude-haiku-5-5');
    assert.equal(first.max_tokens, 6000);
    assert.match(first.system[0].text, /live AI trader/);
    assert.equal(first.messages[0].content[0].text, 'Live decision test');
    const names = first.tools.map((t: any) => t.name);
    assert.ok(names.includes('open_intraday_trade') && names.includes('web_search') && names.includes('buy_stock'));
    assert.ok(!names.includes('run_strategy_scan'));
    assert.equal(first.tools.find((t: any) => t.name === 'web_fetch').max_uses, 1);
  });

  it('stops at the per-decision cost cap', async () => {
    const w = makeWorld();
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ id: 'm', model: 'x', content: [{ type: 'tool_use', id: `t${calls}`, name: 'get_account', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 200_000, output_tokens: 1000 } }),
        { status: 200 },
      );
    }) as typeof fetch;
    const run = await runAgent({
      apiKey: 'k',
      settings: DEFAULT_AI_SETTINGS,
      env: w.env,
      trigger: 'live',
      slot: null,
      previous: null,
      fetchImpl: f,
      mode: {
        model: 'claude-sonnet-5-5',
        system: 's',
        user: 'u',
        clientTools: LIVE_TOOLS,
        makeExecutor: (add) => new LiveSessionTools(w.env, DEFAULT_AI_SETTINGS, add, liveCtx(w)),
        maxRequests: 10,
        maxTokens: 6000,
        maxSearches: 0,
        maxFetches: 0,
        costCapUsd: 0.5,
      },
    });
    assert.equal(calls, 2, '$0.41 then $0.82 crosses the $0.50 cap');
    assert.ok(run.steps.some((s) => /cost cap/.test(s.text)));
  });
});

const ev = (p: Partial<LiveEvent>): LiveEvent => ({
  id: Math.random().toString(36),
  t: NOW - 60_000,
  kind: 'signal',
  symbol: 'INFY.NS',
  title: 'Opening-range breakout',
  detail: '',
  direction: 'long',
  priority: 2,
  link: null,
  runId: null,
  ...p,
});

describe('when Live mode calls Claude', () => {
  const base: TriggerInput = {
    now: NOW,
    minuteOfDay: parseHHMM('10:05'),
    settings: DEFAULT_LIVE_SETTINGS,
    squareOffMinute: parseHHMM('15:20'),
    lastDecisionAt: NOW - 10 * 60_000,
    spentToday: 0.3,
    pending: [],
    openIntraday: 0,
    canOpenNew: true,
  };

  it('paces spend across the session', () => {
    assert.equal(paceAllows(0.2, 3, parseHHMM('09:25')), true);
    assert.equal(paceAllows(1, 3, parseHHMM('09:25')), false);
    assert.equal(paceAllows(1, 3, parseHHMM('11:30')), true);
    assert.equal(paceAllows(3, 3, parseHHMM('15:00')), false);
  });

  it('decides on new events, check-ins and limits', () => {
    assert.equal(decideTrigger({ ...base, minuteOfDay: parseHHMM('09:17') }).run, false);
    assert.equal(decideTrigger({ ...base, minuteOfDay: parseHHMM('15:16') }).run, false);
    assert.equal(decideTrigger({ ...base, spentToday: 3 }).run, false);

    const one = decideTrigger({ ...base, pending: [ev({ priority: 2 })] });
    assert.ok(one.run && one.reason === 'events' && one.events.length === 1);
    // Context-only events wait for the check-in.
    assert.equal(decideTrigger({ ...base, pending: [ev({ priority: 1 })] }).run, false);
    // Too soon after the last decision.
    assert.equal(decideTrigger({ ...base, lastDecisionAt: NOW - 60_000, pending: [ev({ priority: 3 })] }).run, false);
    // Over pace: only events touching a position go through.
    const over = { ...base, minuteOfDay: parseHHMM('09:40'), spentToday: 1.5 };
    assert.equal(decideTrigger({ ...over, pending: [ev({ priority: 2 })] }).run, false);
    assert.equal(decideTrigger({ ...over, pending: [ev({ priority: 3 })] }).run, true);
    // Stale events are ignored.
    assert.equal(decideTrigger({ ...base, pending: [ev({ priority: 2, t: NOW - 40 * 60_000 })] }).run, false);
    // Check-in after 30 minutes, if something can be done.
    const due = decideTrigger({ ...base, lastDecisionAt: NOW - 31 * 60_000 });
    assert.ok(due.run && due.reason === 'check-in');
    assert.equal(decideTrigger({ ...base, lastDecisionAt: NOW - 31 * 60_000, canOpenNew: false }).run, false);
    assert.equal(decideTrigger({ ...base, lastDecisionAt: NOW - 31 * 60_000, canOpenNew: false, openIntraday: 1 }).run, true);
    // With entries exhausted, only position events count.
    assert.equal(decideTrigger({ ...base, canOpenNew: false, pending: [ev({ priority: 2 })] }).run, false);
    // Most urgent first.
    const sorted = decideTrigger({ ...base, pending: [ev({ priority: 1, id: 'low' }), ev({ priority: 3, id: 'high' })] });
    assert.ok(sorted.run && sorted.events[0].id === 'high');
  });

  it('ranks signals by what the AI holds', () => {
    const sig = (kind: LiveSignal['kind'], direction: 'long' | 'short', strength = 0.5): LiveSignal => ({ symbol: 'X', kind, direction, price: 1, time: 0, strength, message: '', paper: null });
    assert.equal(signalPriority(sig('channel_breakdown', 'short'), { intraday: 'long', swing: false }), 3);
    assert.equal(signalPriority(sig('channel_breakout', 'long'), { intraday: 'long', swing: false }), 2);
    assert.equal(signalPriority(sig('ema_cross_up', 'long'), { intraday: null, swing: false }), 1);
    assert.equal(signalPriority(sig('ema_cross_up', 'long', 0.7), { intraday: null, swing: false }), 2);
    assert.equal(signalPriority(sig('sharp_move_down', 'short'), { intraday: null, swing: false }), 2);
    assert.equal(signalPriority(sig('pivot_support_break', 'short'), { intraday: null, swing: true }), 2);
  });

  it('builds the watch list from positions, watchlist, news and the scan', () => {
    const w = makeWorld();
    const r = placeOrder(w.getState(), { instrument: instrumentFromSymbol('TCS.NS'), side: 'BUY', product: 'MIS', type: 'MARKET', qty: 1, price: null, triggerPrice: null }, { now: NOW, quote: quote('TCS.NS', 3400), prices: w.prices });
    const state = { ...r.state, watchlist: [instrumentFromSymbol('^NSEI'), instrumentFromSymbol('GOLDBEES.NS'), instrumentFromSymbol('INFY.NS')] };
    const scan = { stocks: STRATEGY_UNIVERSE.slice(0, 30).map((i) => ({ symbol: i.symbol, price: 500 })) } as any;
    const u = liveUniverse({ state, scan, newsSymbols: ['TATAPOWER.NS'], instrumentFor: (s) => instrumentFromSymbol(s), cap: 10 });
    assert.equal(u[0].symbol, 'TCS.NS');
    assert.equal(u[1].symbol, 'INFY.NS');
    assert.equal(u[2].symbol, 'TATAPOWER.NS');
    assert.equal(u.length, 10);
    assert.ok(!u.some((i) => i.isIndex || i.symbol === 'GOLDBEES.NS'));
  });

  it('turns news into events and finds the previous day', () => {
    const items: NewsItem[] = [
      { id: 'a', source: 'pulse', title: 'Infosys wins $1 bn deal', summary: '', link: 'https://x/a', publishedAt: NOW, symbols: ['INFY.NS'], macro: false, important: true },
      { id: 'b', source: 'pulse', title: 'RBI holds repo rate', summary: '', link: '', publishedAt: NOW, symbols: [], macro: true, important: false },
      { id: 'c', source: 'nse', title: 'Some Co: Trading window', summary: '', link: '', publishedAt: NOW, symbols: ['TCS.NS'], macro: false, important: false },
    ];
    const evs = newsEvents(items, (s) => s === 'INFY.NS', NOW);
    assert.equal(evs.length, 2);
    assert.equal(evs[0].priority, 3);
    assert.equal(evs[1].kind, 'macro');
    const daily = [
      { t: istTimestamp('2026-10-30', 555), h: 10, l: 8, c: 9 },
      { t: istTimestamp(MON, 555), h: 12, l: 9, c: 11 },
    ];
    assert.deepEqual(previousDayContext(daily, MON), { prevHigh: 10, prevLow: 8, prevClose: 9 });
  });
});

describe('news feeds', () => {
  const ctx = matchContext(STRATEGY_UNIVERSE);

  it('matches NSE filings by company and Pulse headlines by name', () => {
    const nse = toNewsItems(
      'nse',
      [
        { title: 'Infosys Limited', description: 'Infosys Limited has informed the Exchange about Outcome of Board Meeting', link: 'https://n/1', guid: 'https://n/1', publishedAt: NOW - 60_000 },
        { title: 'Tata Consultancy Services Limited', description: 'Closure of Trading Window', link: 'https://n/2', guid: 'https://n/2', publishedAt: NOW },
        { title: 'Unlisted Widgets Limited', description: 'Acquisition', link: 'https://n/3', guid: 'https://n/3', publishedAt: NOW },
      ],
      ctx,
      NOW,
    );
    assert.deepEqual(nse[0].symbols, ['INFY.NS']);
    assert.equal(nse[0].important, true);
    assert.equal(nse[1].important, false, 'routine filing');
    assert.deepEqual(nse[2].symbols, []);
    const pulse = toNewsItems('pulse', [{ title: 'Nifty ends higher as RBI cuts repo rate', description: '', link: 'l', guid: 'g', publishedAt: null }], ctx, NOW);
    assert.equal(pulse[0].macro, true);
    assert.equal(pulse[0].publishedAt, NOW);
  });

  it('remembers what it has seen and only treats recent items as new on the first poll', () => {
    const mk = (id: string, ageMin: number): NewsItem => ({ id, source: 'pulse', title: id, summary: '', link: '', publishedAt: NOW - ageMin * 60_000, symbols: [], macro: false, important: false });
    const seen = new Set<string>();
    const first = mergeNews([], [mk('new', 5), mk('old', 60)], seen, NOW, true);
    assert.deepEqual(first.fresh.map((x) => x.id), ['new']);
    assert.equal(first.list.length, 2);
    const second = mergeNews(first.list, [mk('new', 5), mk('late', 70), mk('ancient', 300)], seen, NOW, false);
    assert.deepEqual(second.fresh.map((x) => x.id), ['late']);
    assert.deepEqual(second.list.map((x) => x.id), ['new', 'old', 'late', 'ancient']);
  });

  it('polls with conditional requests and backs off on errors', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const answers: (() => Response)[] = [
      () => new Response('<rss><channel><item><title>Infosys rises</title><link>a</link></item></channel></rss>', { status: 200, headers: { etag: '"v1"' } }),
      () => new Response(null, { status: 304 }),
      () => new Response('oops', { status: 503 }),
    ];
    const poller = new NewsPoller(async (url, init) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return answers.shift()!();
    });
    const only = { pulse: true, nse: false };
    const r1 = await poller.poll(only, NOW);
    assert.equal(r1[0].items[0].title, 'Infosys rises');
    assert.deepEqual(await poller.poll(only, NOW + 60_000), [], 'not due yet');
    assert.deepEqual(await poller.poll(only, NOW + 2 * 60_000), []);
    assert.equal(calls[1].headers['If-None-Match'], '"v1"');
    await poller.poll(only, NOW + 4 * 60_000);
    assert.match(poller.status.pulse.lastError ?? '', /503/);
    assert.ok(poller.status.pulse.nextAt >= NOW + 6 * 60_000);
  });
});

describe('live prompts', () => {
  it('puts the account, positions and events in the message', () => {
    const w = makeWorld();
    const text = buildLiveUserPrompt({
      now: NOW,
      reason: 'events',
      marketStatus: 'open (live prices)',
      indices: [{ name: 'NIFTY 50', level: 25000, changePct: 0.5, fromOpenPct: 0.2 }],
      account: { equity: 1_000_000, available: 900_000 },
      settings: DEFAULT_LIVE_SETTINGS,
      stats: { ...aiIntradayStats(w.getState(), w.quotes(), [], NOW), positions: [{ symbol: 'INFY.NS', tradingSymbol: 'INFY', direction: 'short', qty: 10, avgPrice: 1500, ltp: 1490, pnl: 100, pnlPct: 0.67 }] },
      intradayExits: { 'INFY.NS': { stop: 1515, target: 1470 } },
      swing: [],
      events: [ev({ title: 'Hourly channel breakout', detail: 'Broke 1,512' })],
      earlier: [],
      macro: [],
      decisions: [{ t: NOW - 600_000, text: 'shorted INFY' }],
      watching: 38,
      spentToday: 0.42,
    });
    assert.match(text, /1 new event/);
    assert.match(text, /INFY short 10 @ 1500\.00/);
    assert.match(text, /SL 1515, target 1470/);
    assert.match(text, /Hourly channel breakout/);
    assert.match(text, /\$0\.42 of \$3\.00/);
    const sys = buildLiveSystemPrompt({ ...DEFAULT_LIVE_SETTINGS, allowShort: false }, DEFAULT_AI_SETTINGS, '15:20', 5);
    assert.match(sys, /long trades only/);
    assert.match(sys, /§3\.14/);
  });
});
