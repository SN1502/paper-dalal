import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSystemPrompt, runAgent } from '../src/ai/agent';
import { costOf, withCacheBreakpoint } from '../src/ai/claude';
import { drawdownPaused, sizeBuy, type BuyCheck } from '../src/ai/risk';
import { dueSlot } from '../src/ai/schedule';
import type { AgentEnv } from '../src/ai/tools';
import { DEFAULT_AI_SETTINGS, type AiRun } from '../src/ai/types';
import { instrumentFromSymbol } from '../src/data/instruments';
import { DEFAULT_SETTINGS, createInitialState, placeOrder, updateGtt } from '../src/engine/engine';
import type { Candle, EngineState, Quote } from '../src/engine/types';
import type { ScanResult } from '../src/strategies/scan';
import { istTimestamp, parseHHMM } from '../src/lib/time';

const MON = '2026-11-02';
const at = (hhmm: string) => istTimestamp(MON, parseHHMM(hhmm));
const NOW = at('09:35');

function quote(symbol: string, ltp: number): Quote {
  return {
    symbol,
    ltp,
    prevClose: ltp * 0.99,
    open: ltp,
    high: ltp,
    low: ltp,
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
  for (let i = 0; i < 480; i++) {
    const c = price * (0.8 + (0.2 * i) / 479) * (1 + 0.01 * Math.sin(i / 3));
    out.push({ t: NOW - (480 - i) * 86_400_000, o: c, h: c * 1.01, l: c * 0.99, c, v: Math.round(3e9 / price) });
  }
  out[out.length - 1].c = price;
  return out;
}

function scan(regime: 'risk-on' | 'risk-off'): ScanResult {
  return {
    version: 1,
    computedAt: NOW,
    asOfDay: MON,
    universeSize: 2,
    covered: 1,
    regime: { state: regime, close: 25000, sma100: 24000, sma200: 23000, ret6m: 0.08, mom12_1: 0.12 },
    sectors: [{ sector: 'IT', members: 1, ret6m: 0.1, ret12m: 0.2, aboveMa100: true, aboveMa200: true, rank: 1 }],
    stocks: [
      {
        symbol: 'INFY.NS',
        tradingSymbol: 'INFY',
        name: 'Infosys',
        sector: 'IT',
        price: 1500,
        lastDay: MON,
        bars: 480,
        mom12_1: 0.25,
        momRiskAdj: 0.6,
        vol: 0.22,
        resMom: 0.3,
        beta: 0.9,
        alpha: 0.05,
        r2: 0.4,
        ret1m: 0.03,
        ret6m: 0.12,
        rev5dDemeaned: -0.02,
        aboveSma50: true,
        aboveSma100: true,
        aboveSma200: true,
        ma2: 'up',
        ma3: 'up',
        channel: { high: 1550, low: 1450, position: 0.5, atFloor: false, atCeiling: false },
        pct: { momentum: 95, residualMomentum: 90, lowVol: 70, sector: 100, composite: 97, reversal: 88 },
        composite: 40,
        decile: 10,
        tags: ['Top decile'],
      },
    ],
  };
}

function makeEnv(regime: 'risk-on' | 'risk-off' = 'risk-on') {
  let state: EngineState = createInitialState(at('09:00'), DEFAULT_SETTINGS, []);
  const prices: Record<string, number> = { 'INFY.NS': 1500, 'GOLDBEES.NS': 80, '^NSEI': 25000, '^BSESN': 82000, '^NSEBANK': 56000 };
  const quotes = () => Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, quote(k, v)]));
  const saved: string[] = [];
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
      const r = updateGtt(state, id, patch, NOW, null);
      if (!r.error) state = r.state;
      return { error: r.error };
    },
    marketStatus: () => 'open (live prices)',
    getScan: async () => scan(regime),
    saveFundamentals: (s) => saved.push(s),
  };
  return { env, getState: () => state, saved };
}

type Reply = { status?: number; body: unknown };

function mockFetch(replies: Reply[]) {
  const requests: any[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body ?? '{}')));
    const r = replies.shift();
    if (!r) throw new Error('No more mock replies');
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, requests };
}

const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 };

function reply(content: unknown[], stop: string, extra: Record<string, unknown> = {}): Reply {
  return { body: { id: 'msg', model: 'claude-sonnet-5-5', content, stop_reason: stop, usage: { ...usage, ...extra } } };
}

describe('AI agent loop', () => {
  it('researches, buys within the limits with a bracket exit, and finishes', async () => {
    const { env, getState } = makeEnv();
    const { f, requests } = mockFetch([
      reply(
        [
          { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'Infosys news this week' } },
          { type: 'web_search_tool_result', tool_use_id: 'srv1', content: [] },
          { type: 'tool_use', id: 't1', name: 'get_account', input: {} },
          { type: 'tool_use', id: 't2', name: 'run_strategy_scan', input: {} },
        ],
        'tool_use',
        { server_tool_use: { web_search_requests: 1 } },
      ),
      reply(
        [
          { type: 'tool_use', id: 't3', name: 'score_fundamentals', input: { symbol: 'INFY', quarterly_eps: [15, 15, 16, 16, 16, 17, 17, 18, 18, 19, 19, 21], book_value_per_share: 220 } },
          {
            type: 'tool_use',
            id: 't4',
            name: 'buy_stock',
            input: { symbol: 'INFY', order_type: 'MARKET', stop_loss: 1410, target: 1680, conviction: 4, thesis: 'Top decile (§3.6), SUE 1.8 (§3.2).' },
          },
        ],
        'tool_use',
      ),
      reply([{ type: 'tool_use', id: 't5', name: 'finish', input: { market_view: 'Risk-on.', summary: 'Bought INFY.', watch_next: ['TCS'] } }], 'tool_use'),
    ]);
    const updates: AiRun[] = [];
    const run = await runAgent({
      apiKey: 'sk-test',
      settings: DEFAULT_AI_SETTINGS,
      env,
      trigger: 'manual',
      slot: null,
      previous: null,
      fetchImpl: f,
      onUpdate: (r) => updates.push(r),
    });

    assert.equal(run.status, 'completed', run.error ?? '');
    assert.equal(requests.length, 3);
    assert.equal(run.summary, 'Bought INFY.');
    assert.deepEqual(run.watchNext, ['TCS']);
    assert.equal(run.decisions.length, 1);
    const d = run.decisions[0];
    assert.equal(d.outcome, 'filled');
    assert.equal(d.qty, 66, '10% of a ₹10L account at ₹1,500');
    const state = getState();
    assert.equal(state.positions['INFY.NS|CNC'].ai, true);
    assert.equal(state.gtts[0].stopPrice, 1410);
    assert.equal(state.orders[0].source, 'AI');
    assert.ok(run.steps.some((s) => s.kind === 'search' && s.text.includes('Infosys')));
    assert.ok(updates.length > 3);

    // Tool results go back with matching ids; the system prompt and last user turn are cache breakpoints.
    const second = requests[1];
    const results = second.messages[second.messages.length - 1].content;
    assert.deepEqual(results.map((b: any) => b.tool_use_id), ['t1', 't2']);
    assert.equal(results[results.length - 1].cache_control.type, 'ephemeral');
    assert.equal(second.system[0].cache_control.type, 'ephemeral');
    assert.equal(second.messages[1].content[0].type, 'server_tool_use', 'assistant turn is sent back unchanged');
    assert.ok(second.tools.some((t: any) => t.name === 'web_search'));
    assert.equal(run.usage.searches, 1);
    assert.ok(run.usage.costUsd > 0);
  });

  it('respects the dual-momentum filter in a risk-off market but allows gold', async () => {
    const { env } = makeEnv('risk-off');
    const { f } = mockFetch([
      reply(
        [
          { type: 'tool_use', id: 'a', name: 'buy_stock', input: { symbol: 'INFY', order_type: 'MARKET', stop_loss: 1410, target: 1680, conviction: 3, thesis: 'x' } },
          { type: 'tool_use', id: 'b', name: 'buy_stock', input: { symbol: 'GOLDBEES', order_type: 'MARKET', stop_loss: 76, target: 88, conviction: 3, thesis: 'Risk-off rotation (§4.1.2).' } },
        ],
        'tool_use',
      ),
      reply([{ type: 'tool_use', id: 'c', name: 'finish', input: { market_view: 'Risk-off.', summary: 'Rotated to gold.' } }], 'tool_use'),
    ]);
    const run = await runAgent({ apiKey: 'k', settings: DEFAULT_AI_SETTINGS, env, trigger: 'manual', slot: null, previous: null, fetchImpl: f });
    const [infy, gold] = run.decisions;
    assert.equal(infy.outcome, 'rejected');
    assert.match(infy.error ?? '', /dual momentum/);
    assert.equal(gold.outcome, 'filled', gold.error ?? '');
  });

  it('continues without web search when the API key cannot use it', async () => {
    const { env } = makeEnv();
    const { f, requests } = mockFetch([
      { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'web_search is not enabled for this organization' } } },
      reply([{ type: 'tool_use', id: 'z', name: 'finish', input: { market_view: 'Flat.', summary: 'No trades.' } }], 'tool_use'),
    ]);
    const run = await runAgent({ apiKey: 'k', settings: DEFAULT_AI_SETTINGS, env, trigger: 'manual', slot: null, previous: null, fetchImpl: f });
    assert.equal(run.status, 'completed');
    assert.equal(requests.length, 2);
    assert.ok(!requests[1].tools.some((t: any) => t.name === 'web_search'));
    assert.ok(run.steps.some((s) => s.text.includes('Web search is unavailable')));
  });

  it('reports a rejected key clearly', async () => {
    const { env } = makeEnv();
    const { f } = mockFetch([{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }]);
    const run = await runAgent({ apiKey: 'bad', settings: DEFAULT_AI_SETTINGS, env, trigger: 'manual', slot: null, previous: null, fetchImpl: f });
    assert.equal(run.status, 'failed');
    assert.match(run.error ?? '', /API key was rejected/);
  });

  it('cites the paper in the system prompt', () => {
    const p = buildSystemPrompt(DEFAULT_AI_SETTINGS, NOW, 'open');
    assert.match(p, /151 Trading Strategies/);
    assert.match(p, /§3\.6/);
    assert.match(p, /§4\.1\.2/);
  });
});

describe('risk limits', () => {
  const base: BuyCheck = {
    equity: 1_000_000,
    available: 1_000_000,
    startingCapital: 1_000_000,
    aiPositions: 0,
    buysThisRun: 0,
    alreadyInvolved: false,
    exchange: 'NSE',
    isIndex: false,
    entry: 1000,
    stop: 950,
    target: 1100,
    liquidityCr: 50,
    requestedAllocationPct: null,
    requestedQty: null,
    chargesRate: 0.0013,
    settings: DEFAULT_AI_SETTINGS,
    regime: 'risk-on',
    isSafeHaven: false,
  };

  it('sizes by the smallest of allocation, risk and cash reserve', () => {
    const r = sizeBuy(base);
    assert.equal(r.ok && r.qty, 100, '10% allocation = ₹1L / ₹1,000');
    const tight = sizeBuy({ ...base, stop: 875, target: 1250 });
    assert.equal(tight.ok && tight.qty, 80, '1% risk = ₹10,000 / ₹125 per share');
    const lowCash = sizeBuy({ ...base, available: 230_000 });
    assert.equal(lowCash.ok && lowCash.qty, 29, 'keeps the 20% reserve');
  });

  it('rejects bad stops, poor reward-to-risk, illiquid names and over-limit buys', () => {
    assert.equal(sizeBuy({ ...base, stop: 990 }).ok, false);
    assert.equal(sizeBuy({ ...base, stop: 800 }).ok, false, 'stop more than 15% away');
    assert.equal(sizeBuy({ ...base, target: 1050 }).ok, false, 'reward-to-risk 1.0');
    assert.equal(sizeBuy({ ...base, liquidityCr: 2 }).ok, false);
    assert.equal(sizeBuy({ ...base, aiPositions: 8 }).ok, false);
    assert.equal(sizeBuy({ ...base, buysThisRun: 2 }).ok, false);
    assert.equal(sizeBuy({ ...base, equity: 840_000 }).ok, false, 'drawdown pause');
    assert.equal(drawdownPaused(850_000, 1_000_000, DEFAULT_AI_SETTINGS), true);
  });

  it('applies the market filter only when it is on', () => {
    assert.equal(sizeBuy({ ...base, regime: 'risk-off' }).ok, false);
    assert.equal(sizeBuy({ ...base, regime: 'risk-off', isSafeHaven: true }).ok, true);
    assert.equal(sizeBuy({ ...base, regime: 'risk-off', settings: { ...DEFAULT_AI_SETTINGS, regimeFilter: false } }).ok, true);
  });
});

describe('schedule and API helpers', () => {
  const run = (slot: number, status: AiRun['status'], finishedAt: number): AiRun => ({
    id: 'r',
    trigger: 'auto',
    slot,
    day: MON,
    startedAt: finishedAt - 60_000,
    finishedAt,
    status,
    model: 'claude-sonnet-5-5',
    marketView: null,
    summary: null,
    watchNext: [],
    steps: [],
    decisions: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, searches: 0, fetches: 0, requests: 0, costUsd: 0 },
    error: null,
  });

  it('runs each slot once per trading day and retries failures after a pause', () => {
    const s = DEFAULT_AI_SETTINGS;
    assert.equal(dueSlot(at('09:20'), s, []), null);
    assert.equal(dueSlot(at('09:31'), s, []), 570);
    assert.equal(dueSlot(at('10:00'), s, [run(570, 'completed', at('09:40'))]), null);
    assert.equal(dueSlot(at('09:45'), s, [run(570, 'failed', at('09:40'))]), null, 'waits 20 minutes');
    assert.equal(dueSlot(at('10:05'), s, [run(570, 'failed', at('09:40'))]), 570);
    assert.equal(dueSlot(at('15:25'), s, []), null, 'too close to the close');
    const twice = { ...s, schedule: 'twice' as const };
    assert.equal(dueSlot(at('14:50'), twice, [run(570, 'completed', at('09:40'))]), 885);
    assert.equal(dueSlot(istTimestamp('2026-11-07', 600), s, []), null, 'Saturday');
  });

  it('marks only the last user block for caching and prices usage', () => {
    const msgs = withCacheBreakpoint([
      { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }] },
    ]);
    assert.equal('cache_control' in msgs[0].content[0], false);
    assert.equal(msgs[2].content[0].cache_control.type, 'ephemeral');
    const c = costOf('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 100_000, server_tool_use: { web_search_requests: 10 } });
    assert.equal(Math.round(c * 100) / 100, 3.1);
  });
});
