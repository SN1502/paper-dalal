/**
 * Tools for Live-mode decisions: intraday snapshots, intraday long/short trades with
 * bracket exits, closing and trailing positions, plus the swing tools for delivery trades.
 */
import { activeGttFor, computeFunds, isActive, pricesFromQuotes, roundToTick } from '../engine/engine';
import { accountSummary } from '../engine/selectors';
import { round2 } from '../lib/format';
import { formatIstTime, istParts } from '../lib/time';
import { CLIENT_TOOLS, SessionTools, fail, normalizeSymbol, num, ok, pctOf, type AgentEnv, type ToolOutcome } from '../ai/tools';
import type { AiSettings, AiStep } from '../ai/types';
import { intradaySummary, type DayContext } from './signals';
import type { IntradayState } from './bars';
import type { NewsItem } from './news';
import { checkStopTighten, sizeIntraday, type LiveSettings } from './risk';
import type { IntradayStats } from './stats';
import type { LiveEvent } from './store';

/** What live tools need from the live trader. */
export interface LiveContext {
  settings: LiveSettings;
  stats(): IntradayStats;
  /** Today's 1-minute bars and the previous day's levels, loaded on demand for unwatched stocks. */
  intraday(symbol: string): Promise<{ state: IntradayState; ctx: DayContext | null } | null>;
  newsFor(symbol: string): NewsItem[];
  signalsFor(symbol: string): LiveEvent[];
}

const symbolProp = { type: 'string', description: 'NSE symbol, e.g. "TATAPOWER".' };
const productProp = { type: 'string', enum: ['intraday', 'delivery'] };

const reuse = (name: string) => {
  const t = CLIENT_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`Missing tool ${name}`);
  return t;
};

export const LIVE_TOOLS = [
  {
    name: 'get_intraday_snapshot',
    description:
      "One stock's intraday picture: price, VWAP, opening range, previous-day pivots, EMA(9)/EMA(21) on 5-minute bars, last 5-minute bars, volume, today's signals and news, daily trend and liquidity. Call before trading a stock.",
    input_schema: { type: 'object', properties: { symbol: symbolProp }, required: ['symbol'], additionalProperties: false },
  },
  {
    name: 'open_intraday_trade',
    description:
      'Open an intraday (MIS) position at market, long or short, with a stop-loss and target that the app enforces. The app sizes the position from the risk limits and squares it off at 3:20 PM. Rejected if any limit is breached.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: symbolProp,
        direction: { type: 'string', enum: ['long', 'short'] },
        stop_loss: { type: 'number', description: 'Below the price for a long, above it for a short.' },
        target: { type: 'number', description: 'Above the price for a long, below it for a short.' },
        conviction: { type: 'integer', minimum: 1, maximum: 5 },
        thesis: { type: 'string', description: 'Catalyst, setup and what would prove you wrong, in two or three sentences.' },
      },
      required: ['symbol', 'direction', 'stop_loss', 'target', 'thesis'],
      additionalProperties: false,
    },
  },
  {
    name: 'close_position',
    description: 'Close all or part of a position you opened, at market: an intraday position (long or short) or a delivery holding.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: symbolProp,
        product: productProp,
        quantity: { type: 'integer', minimum: 1, description: 'Omit to close all of it.' },
        reason: { type: 'string' },
      },
      required: ['symbol', 'product', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_exit',
    description:
      'Move the stop-loss and/or target of a position you opened. Stops can only be tightened (raised for a long, lowered for a short), e.g. to trail a winning trade.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: symbolProp,
        product: productProp,
        stop_loss: { type: 'number' },
        target: { type: 'number' },
        reason: { type: 'string' },
      },
      required: ['symbol', 'product', 'reason'],
      additionalProperties: false,
    },
  },
  reuse('get_stock_snapshot'),
  reuse('buy_stock'),
  reuse('get_account'),
  {
    name: 'finish',
    description: 'End this decision. Summarise in one to three sentences what you did (or why you did nothing). Always call this last.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        market_view: { type: 'string', description: 'Optional one-line read of the market right now.' },
        watch_next: { type: 'array', items: { type: 'string' }, description: 'Symbols to keep an eye on.' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
  },
] as const;

export class LiveSessionTools extends SessionTools {
  constructor(
    env: AgentEnv,
    settings: AiSettings,
    onStep: (step: AiStep) => void,
    private live: LiveContext,
  ) {
    super(env, settings, onStep);
    // Swing buys made from Live mode count against the per-session limit for the whole day.
    this.buysThisRun = live.stats().swingBuysToday;
  }

  async execute(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    try {
      switch (name) {
        case 'get_intraday_snapshot':
          return await this.intradaySnapshot(input);
        case 'open_intraday_trade':
          return await this.openIntraday(input);
        case 'close_position':
          return input.product === 'delivery' ? await this.sell(input) : await this.closeIntraday(input);
        case 'update_exit':
          return input.product === 'delivery' ? await this.updateExit(input) : await this.updateIntradayExit(input);
        case 'finish':
          this.finished = {
            marketView: String(input.market_view ?? '').slice(0, 400),
            summary: String(input.summary ?? '').slice(0, 1200),
            watchNext: Array.isArray(input.watch_next) ? input.watch_next.map(String).slice(0, 8) : [],
          };
          return ok({ ok: true });
        case 'get_stock_snapshot':
        case 'buy_stock':
        case 'get_account':
          return await super.execute(name, input);
        default:
          return fail(`Unknown tool ${name}.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Tool failed';
      this.step('error', `${name}: ${msg}`);
      return fail(msg);
    }
  }

  private async intradaySnapshot(input: Record<string, unknown>): Promise<ToolOutcome> {
    const sym = normalizeSymbol(input.symbol);
    if (!sym || sym.startsWith('^')) return fail('Give an NSE stock symbol such as "TCS".');
    const inst = this.env.instrumentFor(sym);
    this.step('tool', `Checked the intraday chart of ${inst.tradingSymbol}`);
    const [q, day, t] = await Promise.all([
      this.env.getQuote(inst),
      this.live.intraday(sym).catch(() => null),
      this.technicals(sym).catch(() => null),
    ]);
    if (!q) return fail(`No price for ${inst.tradingSymbol} on NSE.`);
    const state = this.env.getState();
    const mis = state.positions[`${sym}|MIS`];
    return ok({
      symbol: inst.tradingSymbol,
      name: q.name ?? inst.name,
      ltp: q.ltp,
      day_change_pct: pctOf(q.ltp, q.prevClose),
      last_trade_ist: q.time ? formatIstTime(q.time, true) : null,
      intraday: day ? intradaySummary(day.state, day.ctx, q.ltp) ?? 'No intraday bars yet' : 'Intraday bars unavailable',
      signals_today: this.live
        .signalsFor(sym)
        .slice(0, 8)
        .map((e) => ({ time: formatIstTime(e.t, false), signal: e.title, detail: e.detail, direction: e.direction })),
      news_today: this.live
        .newsFor(sym)
        .slice(0, 6)
        .map((n) => ({ time: formatIstTime(n.publishedAt, false), source: n.source === 'nse' ? 'NSE filing' : 'news', title: n.title, link: n.link || null })),
      daily: t
        ? {
            trend: t.trend,
            rsi14: t.rsi14,
            atr_pct: t.atr_pct,
            sma20: t.sma20,
            sma50: t.sma50,
            sma200: t.sma200,
            support_20d: t.support_20d,
            resistance_20d: t.resistance_20d,
            return_pct: { '1w': t.return_pct['1w'], '1m': t.return_pct['1m'] },
            avg_traded_value_20d_cr: t.avg_traded_value_20d_cr,
          }
        : 'Not enough daily history',
      your_intraday_position:
        mis && mis.netQty !== 0
          ? {
              direction: mis.netQty > 0 ? 'long' : 'short',
              qty: Math.abs(mis.netQty),
              avg_price: round2(mis.avgPrice),
              opened_by: mis.ai ? 'you' : 'user',
              exits: activeGttFor(state, sym, 'MIS').map((g) => ({ stop_loss: g.stopPrice, target: g.targetPrice })),
            }
          : null,
    });
  }

  private intradayDecision(
    inst: { tradingSymbol: string },
    d: Partial<{
      action: 'BUY' | 'SELL' | 'UPDATE_EXIT';
      qty: number | null;
      price: number | null;
      stop: number | null;
      target: number | null;
      conviction: number | null;
      rationale: string;
      orderId: string | null;
      outcome: 'filled' | 'queued' | 'rejected' | 'updated';
      error: string | null;
      direction: 'long' | 'short';
      intent: 'open' | 'close';
    }>,
  ) {
    this.decisions.push({
      symbol: inst.tradingSymbol,
      action: d.action ?? 'BUY',
      qty: d.qty ?? null,
      price: d.price ?? null,
      stop: d.stop ?? null,
      target: d.target ?? null,
      conviction: d.conviction ?? null,
      rationale: d.rationale ?? '',
      orderId: d.orderId ?? null,
      outcome: d.outcome ?? 'rejected',
      error: d.error ?? null,
      product: 'MIS',
      direction: d.direction,
      intent: d.intent,
    });
  }

  private async openIntraday(input: Record<string, unknown>): Promise<ToolOutcome> {
    const sym = normalizeSymbol(input.symbol);
    if (!sym) return fail('Give an NSE symbol such as "TCS".');
    const inst = this.env.instrumentFor(sym);
    const direction = input.direction === 'short' ? 'short' : 'long';
    const long = direction === 'long';
    const stopRaw = num(input.stop_loss);
    const targetRaw = num(input.target);
    const conviction = num(input.conviction);
    const thesis = String(input.thesis ?? '').trim().slice(0, 1000);
    if (stopRaw === null || targetRaw === null) return fail('stop_loss and target are required numbers.');
    const action = long ? 'BUY' : 'SELL';

    const reject = (reason: string, price: number | null): ToolOutcome => {
      this.intradayDecision(inst, { action, price, stop: stopRaw, target: targetRaw, conviction, rationale: thesis, outcome: 'rejected', error: reason, direction, intent: 'open' });
      this.step('error', `Intraday ${direction} ${inst.tradingSymbol} rejected: ${reason}`);
      return { content: JSON.stringify({ status: 'rejected', reason }), isError: true };
    };

    const q = await this.env.getQuote(inst);
    if (!q) return reject('No live price for this symbol.', null);
    const t = await this.technicals(sym).catch(() => null);
    const entry = q.ltp;
    const stop = roundToTick(stopRaw, long ? 'down' : 'up');
    const target = roundToTick(targetRaw, long ? 'up' : 'down');
    const state = this.env.getState();
    const quotes = this.env.quotes();
    const sum = accountSummary(state, quotes);
    const funds = computeFunds(state, pricesFromQuotes(quotes));
    const stats = this.live.stats();
    const misNet = state.positions[`${sym}|MIS`]?.netQty ?? 0;
    const pending = state.orders.some((o) => isActive(o) && o.product === 'MIS' && o.instrument.symbol === sym);

    const sizing = sizeIntraday({
      direction,
      equity: sum.equity,
      available: funds.available,
      leverage: state.settings.misLeverage,
      entry,
      stop,
      target,
      liquidityCr: t ? t.avg_traded_value_20d_cr : null,
      openPositions: stats.openPositions,
      tradesToday: stats.tradesToday,
      pnlToday: stats.pnlToday,
      alreadyInSymbol: misNet !== 0 || pending,
      minutesNow: istParts(this.env.now()).minuteOfDay,
      isIndex: !!inst.isIndex,
      exchange: inst.exchange,
      settings: this.live.settings,
    });
    if (!sizing.ok) return reject(sizing.reason, entry);

    const res = await this.env.placeOrder({
      instrument: inst,
      side: action,
      product: 'MIS',
      type: 'MARKET',
      qty: sizing.qty,
      price: null,
      triggerPrice: null,
      source: 'AI',
      bracket: { stopPrice: stop, targetPrice: target },
    });
    if (res.error || !res.order) return reject(res.error ?? 'Order failed.', entry);
    const o = res.order;
    if (o.status === 'REJECTED') return reject(o.message ?? 'Order rejected.', entry);
    const filled = o.status === 'COMPLETE';
    this.intradayDecision(inst, {
      action,
      qty: o.qty,
      price: filled ? o.avgPrice : entry,
      stop,
      target,
      conviction,
      rationale: thesis,
      orderId: o.id,
      outcome: filled ? 'filled' : 'queued',
      direction,
      intent: 'open',
    });
    this.step(
      'order',
      `${filled ? (long ? 'Bought' : 'Shorted') : `Placed intraday ${direction} for`} ${o.qty} ${inst.tradingSymbol}${filled ? ` at ₹${o.avgPrice}` : ''} · SL ₹${stop} · target ₹${target}`,
    );
    return ok({
      status: filled ? 'filled' : 'queued',
      symbol: inst.tradingSymbol,
      direction,
      qty: o.qty,
      fill_price: filled ? o.avgPrice : null,
      stop_loss: stop,
      target,
      position_value: round2(o.qty * (filled ? (o.avgPrice as number) : entry)),
      max_loss_at_stop: round2(o.qty * Math.abs((filled ? (o.avgPrice as number) : entry) - stop)),
      notes: [...sizing.notes, filled ? 'Stop-loss and target are active.' : 'Exits become active when the order fills.', 'Squared off automatically at 3:20 PM if still open.'],
    });
  }

  private async closeIntraday(input: Record<string, unknown>): Promise<ToolOutcome> {
    const sym = normalizeSymbol(input.symbol);
    if (!sym) return fail('Give an NSE symbol such as "TCS".');
    const inst = this.env.instrumentFor(sym);
    const reason = String(input.reason ?? '').trim().slice(0, 800);
    const p = this.env.getState().positions[`${sym}|MIS`];
    if (!p || p.netQty === 0) return fail(`No open intraday position in ${inst.tradingSymbol}.`);
    if (!p.ai) return fail(`The intraday position in ${inst.tradingSymbol} belongs to the user. Leave it alone.`);
    const direction = p.netQty > 0 ? 'long' : 'short';
    const open = Math.abs(p.netQty);
    const req = num(input.quantity);
    const qty = Math.min(open, req !== null && req > 0 ? Math.floor(req) : open);
    const side = p.netQty > 0 ? 'SELL' : 'BUY';
    const res = await this.env.placeOrder({
      instrument: inst,
      side,
      product: 'MIS',
      type: 'MARKET',
      qty,
      price: null,
      triggerPrice: null,
      source: 'AI',
    });
    const o = res.order;
    if (res.error || !o || o.status === 'REJECTED') {
      const msg = res.error ?? o?.message ?? 'Order failed.';
      this.intradayDecision(inst, { action: side, qty, rationale: reason, orderId: o?.id ?? null, outcome: 'rejected', error: msg, direction, intent: 'close' });
      this.step('error', `Closing ${inst.tradingSymbol} rejected: ${msg}`);
      return { content: JSON.stringify({ status: 'rejected', reason: msg }), isError: true };
    }
    const filled = o.status === 'COMPLETE';
    const pnl = filled && o.avgPrice !== null ? round2((o.avgPrice - p.avgPrice) * qty * (direction === 'long' ? 1 : -1)) : null;
    this.intradayDecision(inst, { action: side, qty, price: o.avgPrice, rationale: reason, orderId: o.id, outcome: filled ? 'filled' : 'queued', direction, intent: 'close' });
    this.step('order', `${filled ? 'Closed' : 'Placed close for'} ${qty} ${inst.tradingSymbol} intraday ${direction}${filled ? ` at ₹${o.avgPrice}` : ''}`);
    return ok({ status: filled ? 'filled' : 'queued', symbol: inst.tradingSymbol, qty, fill_price: o.avgPrice, gross_pnl: pnl, remaining_qty: open - qty });
  }

  private async updateIntradayExit(input: Record<string, unknown>): Promise<ToolOutcome> {
    const sym = normalizeSymbol(input.symbol);
    if (!sym) return fail('Give an NSE symbol such as "TCS".');
    const inst = this.env.instrumentFor(sym);
    const reason = String(input.reason ?? '').trim().slice(0, 800);
    const state = this.env.getState();
    const p = state.positions[`${sym}|MIS`];
    if (!p || p.netQty === 0) return fail(`No open intraday position in ${inst.tradingSymbol}.`);
    const g = activeGttFor(state, sym, 'MIS').find((x) => x.source === 'AI');
    if (!g) return fail(`No active intraday exit that you set on ${inst.tradingSymbol}.`);
    const direction = p.netQty > 0 ? 'long' : 'short';
    const long = direction === 'long';
    const q = await this.env.getQuote(inst);
    if (!q) return fail('No live price for this symbol.');
    const stopIn = num(input.stop_loss);
    const targetIn = num(input.target);
    if (stopIn === null && targetIn === null) return fail('Give a new stop_loss, target, or both.');
    const stop = stopIn !== null ? roundToTick(stopIn, long ? 'down' : 'up') : g.stopPrice;
    const target = targetIn !== null ? roundToTick(targetIn, long ? 'up' : 'down') : g.targetPrice;
    if (stopIn !== null) {
      const err = checkStopTighten(direction, g.stopPrice, stop as number, q.ltp);
      if (err) return fail(err);
    }
    if (target !== null && (long ? target <= q.ltp : target >= q.ltp)) {
      return fail(long ? 'Target must be above the current price.' : 'For a short, the target must be below the current price.');
    }
    const r = this.env.updateGtt(g.id, { stopPrice: stop, targetPrice: target });
    if (r.error) return fail(r.error);
    this.intradayDecision(inst, { action: 'UPDATE_EXIT', qty: g.qty, price: q.ltp, stop, target, rationale: reason, outcome: 'updated', direction });
    this.step('order', `Updated intraday exit for ${inst.tradingSymbol}: SL ₹${stop ?? '—'} · target ₹${target ?? '—'}`);
    return ok({ status: 'updated', symbol: inst.tradingSymbol, stop_loss: stop, target });
  }
}

