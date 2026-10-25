/**
 * PaperDalal trading engine.
 *
 * Every function here is pure: it takes an EngineState and returns a new one
 * (plus user-facing events) without mutating its input. Prices come in from the
 * caller, which keeps the engine fully testable without a network.
 */
import { newId, num, round2, rupees } from '../lib/format';
import {
  SESSION,
  formatHHMM,
  istDayKey,
  istParts,
  istTimestamp,
  isWeekday,
  minuteFloor,
  parseHHMM,
} from '../lib/time';
import { computeCharges } from './charges';
import type {
  Candle,
  DayRecord,
  EngineEvent,
  EngineResult,
  EngineState,
  Fill,
  Holding,
  Instrument,
  Order,
  OrderInput,
  OrderType,
  Position,
  Product,
  Quote,
  Settings,
  Side,
} from './types';

export type PriceBook = Record<string, number>;

const MINUTE = 60_000;
export const MAX_QTY = 100_000;
const KEEP_FILLS = 2_000;
const KEEP_CLOSED_ORDERS = 2_000;
const KEEP_DAYS = 400;

export const DEFAULT_SETTINGS: Settings = {
  startingCapital: 1_000_000,
  misLeverage: 5,
  squareOffTime: '15:20',
  refreshSeconds: 5,
  slippageBps: 0,
  dpChargePerScrip: 15.34,
};

/* ------------------------------------------------------------------ */
/* State construction                                                   */
/* ------------------------------------------------------------------ */

export function createInitialState(
  now: number,
  settings: Settings = DEFAULT_SETTINGS,
  watchlist: Instrument[] = [],
): EngineState {
  return {
    schemaVersion: 1,
    account: {
      cash: settings.startingCapital,
      realizedPnl: 0,
      chargesPaid: 0,
      createdAt: now,
    },
    settings: { ...settings },
    orders: [],
    fills: [],
    positions: {},
    holdings: {},
    watchlist: [...watchlist],
    dayLog: [],
    tradingDay: istDayKey(now),
    squaredOffDay: null,
  };
}

export function resetAccount(state: EngineState, now: number, startingCapital?: number): EngineState {
  const settings = { ...state.settings, startingCapital: startingCapital ?? state.settings.startingCapital };
  return createInitialState(now, settings, state.watchlist);
}

export function updateSettings(state: EngineState, patch: Partial<Settings>): EngineState {
  return { ...state, settings: { ...state.settings, ...patch } };
}

export function addToWatchlist(state: EngineState, instrument: Instrument): EngineState {
  if (state.watchlist.some((i) => i.symbol === instrument.symbol)) return state;
  return { ...state, watchlist: [...state.watchlist, instrument] };
}

export function removeFromWatchlist(state: EngineState, symbol: string): EngineState {
  if (!state.watchlist.some((i) => i.symbol === symbol)) return state;
  return { ...state, watchlist: state.watchlist.filter((i) => i.symbol !== symbol) };
}

export function moveInWatchlist(state: EngineState, symbol: string, delta: -1 | 1): EngineState {
  const idx = state.watchlist.findIndex((i) => i.symbol === symbol);
  const to = idx + delta;
  if (idx < 0 || to < 0 || to >= state.watchlist.length) return state;
  const list = [...state.watchlist];
  const [item] = list.splice(idx, 1);
  list.splice(to, 0, item);
  return { ...state, watchlist: list };
}

/* ------------------------------------------------------------------ */
/* Price rules                                                          */
/* ------------------------------------------------------------------ */

/** NSE cash-market tick: ₹0.01 below ₹250 (since June 2024), ₹0.05 otherwise. */
export function tickSize(price: number): number {
  return price < 250 ? 0.01 : 0.05;
}

export function isOnTick(price: number): boolean {
  const t = tickSize(price);
  const n = Math.round(price / t);
  return Math.abs(n * t - price) < 1e-6;
}

export function roundToTick(price: number, mode: 'up' | 'down' | 'nearest' = 'nearest'): number {
  const t = tickSize(price);
  const units = price / t;
  const r = mode === 'up' ? Math.ceil(units - 1e-9) : mode === 'down' ? Math.floor(units + 1e-9) : Math.round(units);
  return round2(r * t);
}

export function applySlippage(price: number, side: Side, bps: number): number {
  if (!bps) return round2(price);
  return side === 'BUY' ? roundToTick(price * (1 + bps / 10_000), 'up') : roundToTick(price * (1 - bps / 10_000), 'down');
}

/**
 * A quote can execute orders only if it is from today's regular session and was
 * received recently. Holidays and stale feeds therefore never fill anything.
 */
export function isLiveQuote(q: Quote, now: number): boolean {
  if (!q.time || !isWeekday(now)) return false;
  const nowMin = istParts(now).minuteOfDay;
  if (nowMin < SESSION.open || nowMin >= SESSION.close) return false;
  if (istDayKey(q.time) !== istDayKey(now)) return false;
  const qMin = istParts(q.time).minuteOfDay;
  if (qMin < SESSION.open || qMin > SESSION.close) return false;
  return now - q.fetchedAt < 90_000;
}

export function pricesFromQuotes(quotes: Record<string, Quote>): PriceBook {
  const out: PriceBook = {};
  for (const q of Object.values(quotes)) out[q.symbol] = q.ltp;
  return out;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

export function positionKey(symbol: string, product: Product): string {
  return `${symbol}|${product}`;
}

export function isActive(o: Order): boolean {
  return o.status === 'OPEN' || o.status === 'TRIGGER_PENDING';
}

function findOrder(state: EngineState, id: string): Order | undefined {
  return state.orders.find((o) => o.id === id);
}

function patchOrder(state: EngineState, id: string, patch: Partial<Order>): EngineState {
  return { ...state, orders: state.orders.map((o) => (o.id === id ? { ...o, ...patch } : o)) };
}

function event(kind: EngineEvent['kind'], title: string, body: string, extra: Partial<EngineEvent> = {}): EngineEvent {
  return { id: newId('E'), kind, title, body, ...extra };
}

const productLabel = (p: Product) => (p === 'MIS' ? 'Intraday' : 'Delivery');
const verb = (s: Side) => (s === 'BUY' ? 'Bought' : 'Sold');

function refPriceFor(input: Pick<OrderInput, 'type' | 'price' | 'triggerPrice'>, ltp: number): number {
  if ((input.type === 'LIMIT' || input.type === 'SL') && input.price) return input.price;
  if (input.type === 'SL-M' && input.triggerPrice) return input.triggerPrice;
  return ltp;
}

/* ------------------------------------------------------------------ */
/* Funds                                                                */
/* ------------------------------------------------------------------ */

export interface FundsSnapshot {
  cash: number;
  /** Margin held by open intraday positions. */
  misMargin: number;
  /** Funds reserved by pending orders. */
  orderBlocks: number;
  /** Mark-to-market of open intraday positions. */
  misUnrealized: number;
  available: number;
}

export function computeFunds(state: EngineState, prices: PriceBook): FundsSnapshot {
  let misMargin = 0;
  let misUnrealized = 0;
  for (const p of Object.values(state.positions)) {
    if (p.product !== 'MIS') continue;
    misMargin += p.blockedMargin;
    if (p.netQty !== 0) {
      const ltp = prices[p.instrument.symbol] ?? p.avgPrice;
      misUnrealized += p.netQty * (ltp - p.avgPrice);
    }
  }
  let orderBlocks = 0;
  for (const o of state.orders) if (isActive(o)) orderBlocks += o.blockedAmount;
  const cash = state.account.cash;
  return {
    cash,
    misMargin: round2(misMargin),
    orderBlocks: round2(orderBlocks),
    misUnrealized: round2(misUnrealized),
    available: round2(cash - misMargin - orderBlocks + Math.min(0, misUnrealized)),
  };
}

/** Quantity that can still be sold under CNC: holdings + today's delivery buys − pending CNC sells. */
export function sellableQty(state: EngineState, symbol: string, excludeOrderId?: string): number {
  const held = state.holdings[symbol]?.qty ?? 0;
  const today = Math.max(0, state.positions[positionKey(symbol, 'CNC')]?.netQty ?? 0);
  let pending = 0;
  for (const o of state.orders) {
    if (o.id === excludeOrderId || !isActive(o)) continue;
    if (o.instrument.symbol === symbol && o.product === 'CNC' && o.side === 'SELL') pending += o.qty;
  }
  return Math.max(0, held + today - pending);
}

/** Funds an order needs reserved: full value for delivery buys, margin for new intraday exposure. */
export function estimateBlock(state: EngineState, input: OrderInput, refPrice: number): number {
  const charges = computeCharges({
    product: input.product,
    side: input.side,
    exchange: input.instrument.exchange,
    qty: input.qty,
    price: refPrice,
  }).total;
  if (input.product === 'CNC') return input.side === 'BUY' ? round2(input.qty * refPrice + charges) : 0;
  const net = state.positions[positionKey(input.instrument.symbol, 'MIS')]?.netQty ?? 0;
  const reducing = input.side === 'BUY' ? Math.max(0, -net) : Math.max(0, net);
  const opening = Math.max(0, input.qty - reducing);
  if (opening === 0) return 0;
  return round2((opening * refPrice) / Math.max(1, state.settings.misLeverage) + charges);
}

/* ------------------------------------------------------------------ */
/* Validation                                                           */
/* ------------------------------------------------------------------ */

export interface ValidationContext {
  now: number;
  ltp: number | null;
  prices: PriceBook;
  excludeOrderId?: string;
}

export function validateOrder(state: EngineState, input: OrderInput, ctx: ValidationContext): string | null {
  const { instrument: inst, side, product, type } = input;
  if (inst.isIndex) return "Indices can't be traded. Pick a stock or ETF.";
  if (!Number.isInteger(input.qty) || input.qty < 1) return 'Enter a whole number of shares, at least 1.';
  if (input.qty > MAX_QTY) return `The maximum is ${num(MAX_QTY, 0)} shares per order.`;

  if (type === 'LIMIT' || type === 'SL') {
    const p = input.price;
    if (p === null || !(p > 0)) return 'Enter a limit price.';
    if (!isOnTick(p)) return `Limit price must be a multiple of ₹${tickSize(p).toFixed(2)}.`;
  }
  if (type === 'SL' || type === 'SL-M') {
    const t = input.triggerPrice;
    if (t === null || !(t > 0)) return 'Enter a trigger price.';
    if (!isOnTick(t)) return `Trigger price must be a multiple of ₹${tickSize(t).toFixed(2)}.`;
  }
  if (ctx.ltp === null) return 'Waiting for a price for this stock. Try again in a moment.';

  if (type === 'SL' || type === 'SL-M') {
    const t = input.triggerPrice as number;
    if (side === 'BUY' && t <= ctx.ltp) return `A stop-loss buy needs a trigger above the last price (${rupees(ctx.ltp)}).`;
    if (side === 'SELL' && t >= ctx.ltp) return `A stop-loss sell needs a trigger below the last price (${rupees(ctx.ltp)}).`;
    if (type === 'SL') {
      const p = input.price as number;
      if (side === 'BUY' && p < t) return 'For a stop-loss buy, set the limit price at or above the trigger.';
      if (side === 'SELL' && p > t) return 'For a stop-loss sell, set the limit price at or below the trigger.';
    }
  }

  const sqMin = parseHHMM(state.settings.squareOffTime);
  const nowMin = istParts(ctx.now).minuteOfDay;
  if (product === 'MIS' && isWeekday(ctx.now) && nowMin >= sqMin && nowMin < SESSION.close) {
    return `Intraday (MIS) orders close at ${formatHHMM(sqMin)}. Use Delivery (CNC) instead.`;
  }

  if (product === 'CNC' && side === 'SELL') {
    const can = sellableQty(state, inst.symbol, ctx.excludeOrderId);
    if (input.qty > can) {
      return can > 0
        ? `You can sell up to ${can} ${inst.tradingSymbol}. Delivery (CNC) can't short sell; use Intraday (MIS).`
        : `You don't hold ${inst.tradingSymbol}. Delivery (CNC) can't short sell; use Intraday (MIS).`;
    }
  }

  const need = estimateBlock(state, input, refPriceFor(input, ctx.ltp));
  if (need > 0) {
    const funds = computeFunds(state, ctx.prices);
    const released = ctx.excludeOrderId ? findOrder(state, ctx.excludeOrderId)?.blockedAmount ?? 0 : 0;
    const available = funds.available + released;
    if (need > available + 0.005) {
      return `Not enough funds. This order needs ${rupees(need)}; you have ${rupees(Math.max(0, available))} available.`;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Positions and fills                                                  */
/* ------------------------------------------------------------------ */

interface PositionUpdate {
  pos: Position;
  realized: number;
  marginDelta: number;
}

export function applyToPosition(
  prev: Position | undefined,
  instrument: Instrument,
  product: Product,
  side: Side,
  qty: number,
  price: number,
  leverage: number,
): PositionUpdate {
  const p: Position = prev
    ? { ...prev }
    : {
        key: positionKey(instrument.symbol, product),
        instrument,
        product,
        netQty: 0,
        avgPrice: 0,
        buyQty: 0,
        buyValue: 0,
        sellQty: 0,
        sellValue: 0,
        realizedPnl: 0,
        blockedMargin: 0,
      };
  const startMargin = p.blockedMargin;
  if (side === 'BUY') {
    p.buyQty += qty;
    p.buyValue = round2(p.buyValue + qty * price);
  } else {
    p.sellQty += qty;
    p.sellValue = round2(p.sellValue + qty * price);
  }

  const dir = side === 'BUY' ? 1 : -1;
  let remaining = qty;
  let realized = 0;

  // Reduce an opposite position first.
  if (p.netQty !== 0 && Math.sign(p.netQty) !== dir) {
    const absNet = Math.abs(p.netQty);
    const closeQty = Math.min(remaining, absNet);
    realized = closeQty * (price - p.avgPrice) * Math.sign(p.netQty);
    if (product === 'MIS') p.blockedMargin = (p.blockedMargin * (absNet - closeQty)) / absNet;
    p.netQty += dir * closeQty;
    remaining -= closeQty;
    if (p.netQty === 0) {
      p.avgPrice = 0;
      p.blockedMargin = 0;
    }
  }
  // Open or add to a position with whatever is left.
  if (remaining > 0) {
    const absNet = Math.abs(p.netQty);
    p.avgPrice = (absNet * p.avgPrice + remaining * price) / (absNet + remaining);
    p.netQty += dir * remaining;
    if (product === 'MIS') p.blockedMargin += (remaining * price) / Math.max(1, leverage);
  }
  p.realizedPnl = round2(p.realizedPnl + realized);
  p.blockedMargin = round2(p.blockedMargin);
  return { pos: p, realized: round2(realized), marginDelta: round2(p.blockedMargin - startMargin) };
}

function rejectOrder(state: EngineState, order: Order, time: number, message: string): EngineResult {
  const s = patchOrder(state, order.id, {
    status: 'REJECTED',
    message,
    blockedAmount: 0,
    updatedAt: time,
    evaluated: true,
  });
  return {
    state: s,
    events: [event('reject', `${order.side === 'BUY' ? 'Buy' : 'Sell'} ${order.instrument.tradingSymbol} rejected`, message, { side: order.side, orderId: order.id })],
  };
}

/** Executes an active order completely at `rawPrice`. */
export function fillOrder(
  state: EngineState,
  orderId: string,
  rawPrice: number,
  time: number,
  prices: PriceBook,
  note: string | null = null,
): EngineResult {
  const order = findOrder(state, orderId);
  if (!order || !isActive(order)) return { state, events: [] };

  const price = round2(rawPrice);
  const { instrument: inst, side, product, qty } = order;
  const leverage = Math.max(1, state.settings.misLeverage);
  const day = state.tradingDay;

  let positions = state.positions;
  let holdings = state.holdings;
  let realized = 0;
  let dpCharge = 0;
  let exposureNeed = 0;

  if (product === 'CNC') {
    const key = positionKey(inst.symbol, 'CNC');
    const pos = positions[key];
    if (side === 'BUY') {
      const u = applyToPosition(pos, inst, 'CNC', 'BUY', qty, price, leverage);
      positions = { ...positions, [key]: u.pos };
      exposureNeed = qty * price;
    } else {
      const fromToday = Math.min(qty, Math.max(0, pos?.netQty ?? 0));
      const fromHoldings = qty - fromToday;
      const h = holdings[inst.symbol];
      if (fromHoldings > (h?.qty ?? 0)) {
        return rejectOrder(state, order, time, `You no longer hold enough ${inst.tradingSymbol} to sell ${qty}.`);
      }
      if (fromToday > 0) {
        const u = applyToPosition(pos, inst, 'CNC', 'SELL', fromToday, price, leverage);
        positions = { ...positions, [key]: u.pos };
        realized += u.realized;
      }
      if (fromHoldings > 0 && h) {
        realized += round2(fromHoldings * (price - h.avgPrice));
        holdings = { ...holdings };
        const left = h.qty - fromHoldings;
        if (left > 0) holdings[inst.symbol] = { ...h, qty: left };
        else delete holdings[inst.symbol];
        const alreadyCharged = state.fills.some(
          (f) => f.tradingDay === day && f.instrument.symbol === inst.symbol && f.charges.dp > 0,
        );
        dpCharge = alreadyCharged ? 0 : state.settings.dpChargePerScrip;
      }
    }
  } else {
    const key = positionKey(inst.symbol, 'MIS');
    const u = applyToPosition(positions[key], inst, 'MIS', side, qty, price, leverage);
    positions = { ...positions, [key]: u.pos };
    realized += u.realized;
    exposureNeed = Math.max(0, u.marginDelta);
  }

  const charges = computeCharges({ product, side, exchange: inst.exchange, qty, price, dpCharge });

  if (exposureNeed > 0) {
    const funds = computeFunds(state, prices);
    const available = funds.available + order.blockedAmount;
    const need = exposureNeed + charges.total;
    if (need > available + 0.005) {
      return rejectOrder(
        state,
        order,
        time,
        `Not enough funds when the order executed: needed ${rupees(need)}, available ${rupees(Math.max(0, available))}.`,
      );
    }
  }

  let cash = state.account.cash;
  if (product === 'CNC') cash += side === 'BUY' ? -(qty * price) - charges.total : qty * price - charges.total;
  else cash += realized - charges.total;

  const fill: Fill = {
    id: newId('T'),
    orderId: order.id,
    instrument: inst,
    side,
    product,
    qty,
    price,
    time,
    tradingDay: day,
    charges,
    realizedPnl: round2(realized),
    note,
  };

  const next: EngineState = {
    ...state,
    account: {
      ...state.account,
      cash: round2(cash),
      realizedPnl: round2(state.account.realizedPnl + realized),
      chargesPaid: round2(state.account.chargesPaid + charges.total),
    },
    positions,
    holdings,
    fills: [fill, ...state.fills],
    orders: state.orders.map((o) =>
      o.id === order.id
        ? {
            ...o,
            status: 'COMPLETE',
            filledQty: qty,
            avgPrice: price,
            filledAt: time,
            updatedAt: time,
            blockedAmount: 0,
            evaluated: true,
          }
        : o,
    ),
  };

  const pnlText = realized !== 0 ? ` · P&L ${realized > 0 ? '+' : ''}${rupees(realized)}` : '';
  return {
    state: next,
    events: [
      event(
        'fill',
        `${verb(side)} ${qty} ${inst.tradingSymbol}`,
        `at ${rupees(price)} · ${productLabel(product)}${pnlText}${note ? ` · ${note}` : ''}`,
        { side, orderId: order.id },
      ),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Matching                                                             */
/* ------------------------------------------------------------------ */

export interface Bar {
  o: number;
  h: number;
  l: number;
}

/**
 * Decides whether an order triggers and/or fills against a price.
 * `tick` mode uses a single last-traded price. A resting limit order then fills at its
 * own limit (the price at which it would really have traded); only the first check of a
 * session (marketable on arrival, or a gap at the open) fills at the better market price.
 * `bar` mode replays 1-minute candles while the app was closed.
 */
export function evaluateOrder(o: Order, bar: Bar, mode: 'tick' | 'bar', slippageBps: number): { fillPrice: number | null; triggered: boolean } {
  const buy = o.side === 'BUY';
  const slip = (p: number) => applySlippage(p, o.side, slippageBps);

  if (o.status === 'TRIGGER_PENDING') {
    const t = o.triggerPrice as number;
    const hit = buy ? bar.h >= t : bar.l <= t;
    if (!hit) return { fillPrice: null, triggered: false };
    const activation = buy ? Math.max(t, bar.o) : Math.min(t, bar.o);
    if (o.type === 'SL-M') return { fillPrice: slip(activation), triggered: true };
    const limit = o.price as number;
    const marketable = buy ? activation <= limit : activation >= limit;
    return { fillPrice: marketable ? round2(activation) : null, triggered: true };
  }

  if (o.type === 'MARKET' || o.type === 'SL-M') return { fillPrice: slip(bar.o), triggered: false };

  const limit = o.price as number;
  if (buy) {
    if (bar.l > limit) return { fillPrice: null, triggered: false };
    if (mode === 'bar') return { fillPrice: round2(Math.min(limit, bar.o)), triggered: false };
    return { fillPrice: round2(o.evaluated ? limit : Math.min(limit, bar.o)), triggered: false };
  }
  if (bar.h < limit) return { fillPrice: null, triggered: false };
  if (mode === 'bar') return { fillPrice: round2(Math.max(limit, bar.o)), triggered: false };
  return { fillPrice: round2(o.evaluated ? limit : Math.max(limit, bar.o)), triggered: false };
}

function matchOrder(state: EngineState, order: Order, bar: Bar, mode: 'tick' | 'bar', time: number, prices: PriceBook): EngineResult {
  const res = evaluateOrder(order, bar, mode, state.settings.slippageBps);
  let s = state;
  const events: EngineEvent[] = [];
  if (res.triggered && order.status === 'TRIGGER_PENDING') {
    s = patchOrder(s, order.id, { status: 'OPEN', triggeredAt: time, updatedAt: time });
    events.push(
      event(
        'trigger',
        `Stop-loss triggered · ${order.instrument.tradingSymbol}`,
        `${order.side} ${order.qty} at trigger ${rupees(order.triggerPrice)}`,
        { side: order.side, orderId: order.id },
      ),
    );
  }
  if (res.fillPrice !== null) {
    const r = fillOrder(s, order.id, res.fillPrice, time, prices);
    s = r.state;
    events.push(...r.events);
  } else if (!order.evaluated) {
    s = patchOrder(s, order.id, { evaluated: true });
  }
  return { state: s, events };
}

/* ------------------------------------------------------------------ */
/* Order lifecycle                                                      */
/* ------------------------------------------------------------------ */

export interface PlaceContext {
  now: number;
  quote: Quote | null;
  prices: PriceBook;
}

export interface PlaceResult extends EngineResult {
  order: Order | null;
  error: string | null;
}

function normalizeInput(input: OrderInput): OrderInput {
  const usesPrice = input.type === 'LIMIT' || input.type === 'SL';
  const usesTrigger = input.type === 'SL' || input.type === 'SL-M';
  return {
    ...input,
    qty: input.qty,
    price: usesPrice && input.price !== null ? round2(input.price) : null,
    triggerPrice: usesTrigger && input.triggerPrice !== null ? round2(input.triggerPrice) : null,
  };
}

export function placeOrder(state: EngineState, rawInput: OrderInput, ctx: PlaceContext): PlaceResult {
  const input = normalizeInput(rawInput);
  let s = state;
  const events: EngineEvent[] = [];
  const today = istDayKey(ctx.now);
  if (today > s.tradingDay) {
    const r = rolloverTo(s, today, ctx.prices);
    s = r.state;
    events.push(...r.events);
  }

  const ltp = ctx.quote?.ltp ?? null;
  const error = validateOrder(s, input, { now: ctx.now, ltp, prices: ctx.prices });
  if (error) return { state: s, events, order: null, error };

  const live = !!ctx.quote && isLiveQuote(ctx.quote, ctx.now);
  const order: Order = {
    id: newId('O'),
    instrument: input.instrument,
    side: input.side,
    product: input.product,
    type: input.type,
    qty: input.qty,
    price: input.price,
    triggerPrice: input.triggerPrice,
    status: input.type === 'SL' || input.type === 'SL-M' ? 'TRIGGER_PENDING' : 'OPEN',
    amo: !live,
    sessionDay: live ? today : null,
    evaluated: false,
    blockedAmount: estimateBlock(s, input, refPriceFor(input, ltp as number)),
    placedAt: ctx.now,
    updatedAt: ctx.now,
    triggeredAt: null,
    filledAt: null,
    avgPrice: null,
    filledQty: 0,
    message: null,
    source: 'USER',
  };
  s = { ...s, orders: [order, ...s.orders] };

  if (live && ctx.quote) {
    const q = ctx.quote.ltp;
    const r = matchOrder(s, order, { o: q, h: q, l: q }, 'tick', ctx.now, ctx.prices);
    s = r.state;
    events.push(...r.events);
    const after = findOrder(s, order.id) as Order;
    if (isActive(after) && !r.events.some((e) => e.kind === 'trigger')) {
      events.push(event('info', 'Order placed', describeOrder(after), { side: after.side, orderId: after.id }));
    }
  } else {
    events.push(
      event('info', 'Order queued for market open', `${describeOrder(order)} · executes from 9:15 AM on the next trading session`, {
        side: order.side,
        orderId: order.id,
      }),
    );
  }
  return { state: s, events, order: findOrder(s, order.id) ?? null, error: null };
}

export function describeOrder(o: Pick<Order, 'side' | 'qty' | 'instrument' | 'type' | 'price' | 'triggerPrice' | 'product'>): string {
  const px =
    o.type === 'MARKET'
      ? 'at market'
      : o.type === 'LIMIT'
        ? `limit ${rupees(o.price)}`
        : o.type === 'SL'
          ? `SL trigger ${rupees(o.triggerPrice)}, limit ${rupees(o.price)}`
          : `SL-M trigger ${rupees(o.triggerPrice)}`;
  return `${o.side} ${o.qty} ${o.instrument.tradingSymbol} ${px} · ${productLabel(o.product)}`;
}

export interface ModifyChanges {
  qty?: number;
  type?: OrderType;
  price?: number | null;
  triggerPrice?: number | null;
}

export function modifyOrder(state: EngineState, orderId: string, changes: ModifyChanges, ctx: PlaceContext): PlaceResult {
  const o = findOrder(state, orderId);
  if (!o || !isActive(o)) return { state, events: [], order: o ?? null, error: 'This order is no longer open, so it can’t be modified.' };
  if (o.source !== 'USER') return { state, events: [], order: o, error: 'System orders can’t be modified.' };

  const input = normalizeInput({
    instrument: o.instrument,
    side: o.side,
    product: o.product,
    type: changes.type ?? o.type,
    qty: changes.qty ?? o.qty,
    price: changes.price !== undefined ? changes.price : o.price,
    triggerPrice: changes.triggerPrice !== undefined ? changes.triggerPrice : o.triggerPrice,
  });
  const ltp = ctx.quote?.ltp ?? null;
  const error = validateOrder(state, input, { now: ctx.now, ltp, prices: ctx.prices, excludeOrderId: o.id });
  if (error) return { state, events: [], order: o, error };

  const keepTriggered = o.type === 'SL' && input.type === 'SL' && o.status === 'OPEN' && o.triggeredAt !== null;
  const status = input.type === 'SL' || input.type === 'SL-M' ? (keepTriggered ? 'OPEN' : 'TRIGGER_PENDING') : 'OPEN';
  const withoutOrder: EngineState = { ...state, orders: state.orders.filter((x) => x.id !== o.id) };
  const blockedAmount = estimateBlock(withoutOrder, input, refPriceFor(input, ltp as number));

  let s = patchOrder(state, o.id, {
    type: input.type,
    qty: input.qty,
    price: input.price,
    triggerPrice: input.triggerPrice,
    status,
    triggeredAt: keepTriggered ? o.triggeredAt : null,
    blockedAmount,
    evaluated: false,
    updatedAt: ctx.now,
  });
  const events: EngineEvent[] = [];
  const updated = findOrder(s, o.id) as Order;
  if (ctx.quote && isLiveQuote(ctx.quote, ctx.now) && updated.sessionDay === istDayKey(ctx.now)) {
    const q = ctx.quote.ltp;
    const r = matchOrder(s, updated, { o: q, h: q, l: q }, 'tick', ctx.now, ctx.prices);
    s = r.state;
    events.push(...r.events);
  }
  if (!events.some((e) => e.kind === 'fill')) {
    events.push(event('info', 'Order modified', describeOrder(updated), { side: updated.side, orderId: updated.id }));
  }
  return { state: s, events, order: findOrder(s, o.id) ?? null, error: null };
}

export function cancelOrder(state: EngineState, orderId: string, now: number, reason = 'Cancelled by you'): EngineResult {
  const o = findOrder(state, orderId);
  if (!o || !isActive(o)) return { state, events: [] };
  const s = patchOrder(state, orderId, { status: 'CANCELLED', message: reason, blockedAmount: 0, updatedAt: now });
  return {
    state: s,
    events: [event('cancel', 'Order cancelled', describeOrder(o), { side: o.side, orderId: o.id })],
  };
}

/* ------------------------------------------------------------------ */
/* Square-off, expiry and day rollover                                   */
/* ------------------------------------------------------------------ */

/**
 * Closes all open intraday positions of `day` and cancels its pending intraday orders.
 * With `force`, positions without a price are closed at their average (no P&L).
 */
export function squareOffIntraday(
  state: EngineState,
  day: string,
  priceOf: (symbol: string) => number | null,
  time: number,
  note: string,
  prices: PriceBook,
  force = false,
): EngineResult {
  let s = state;
  const events: EngineEvent[] = [];

  let cancelled = 0;
  for (const o of s.orders) {
    if (!isActive(o) || o.product !== 'MIS') continue;
    if (o.sessionDay === day || (force && o.sessionDay !== null && o.sessionDay <= day)) {
      s = patchOrder(s, o.id, { status: 'CANCELLED', message: 'Cancelled at intraday square-off', blockedAmount: 0, updatedAt: time });
      cancelled++;
    }
  }

  let closed = 0;
  let remaining = 0;
  let pnl = 0;
  for (const pos of Object.values(s.positions)) {
    if (pos.product !== 'MIS' || pos.netQty === 0) continue;
    const px = priceOf(pos.instrument.symbol) ?? (force ? pos.avgPrice : null);
    if (px === null) {
      remaining++;
      continue;
    }
    const side: Side = pos.netQty > 0 ? 'SELL' : 'BUY';
    const qty = Math.abs(pos.netQty);
    const order: Order = {
      id: newId('O'),
      instrument: pos.instrument,
      side,
      product: 'MIS',
      type: 'MARKET',
      qty,
      price: null,
      triggerPrice: null,
      status: 'OPEN',
      amo: false,
      sessionDay: day,
      evaluated: true,
      blockedAmount: 0,
      placedAt: time,
      updatedAt: time,
      triggeredAt: null,
      filledAt: null,
      avgPrice: null,
      filledQty: 0,
      message: note,
      source: 'SQUARE_OFF',
    };
    s = { ...s, orders: [order, ...s.orders] };
    const r = fillOrder(s, order.id, applySlippage(px, side, s.settings.slippageBps), time, prices, note);
    s = r.state;
    const f = s.fills[0];
    if (f && f.orderId === order.id) pnl += f.realizedPnl;
    closed++;
  }

  if (remaining === 0) s = { ...s, squaredOffDay: day };
  if (closed > 0 || cancelled > 0) {
    const parts: string[] = [];
    if (closed > 0) parts.push(`${closed} position${closed > 1 ? 's' : ''} closed (P&L ${pnl >= 0 ? '+' : ''}${rupees(pnl)})`);
    if (cancelled > 0) parts.push(`${cancelled} pending order${cancelled > 1 ? 's' : ''} cancelled`);
    events.push(event('squareoff', 'Intraday square-off', `${parts.join(', ')} · ${note}`));
  }
  return { state: s, events };
}

/** Cancels pending orders whose session has ended. */
export function expireOrders(state: EngineState, predicate: (o: Order) => boolean, time: number): EngineResult {
  let count = 0;
  const orders = state.orders.map((o) => {
    if (!isActive(o) || !predicate(o)) return o;
    count++;
    return { ...o, status: 'CANCELLED' as const, message: 'Expired at market close', blockedAmount: 0, updatedAt: time };
  });
  if (count === 0) return { state, events: [] };
  return {
    state: { ...state, orders },
    events: [event('expire', `${count} order${count > 1 ? 's' : ''} expired`, 'Unfilled day orders are cancelled at 3:30 PM.')],
  };
}

function summarizeDay(state: EngineState, day: string): DayRecord | null {
  const fills = state.fills.filter((f) => f.tradingDay === day);
  if (fills.length === 0) return null;
  let realized = 0;
  let charges = 0;
  let turnover = 0;
  for (const f of fills) {
    realized += f.realizedPnl;
    charges += f.charges.total;
    turnover += f.qty * f.price;
  }
  return { day, realizedPnl: round2(realized), charges: round2(charges), trades: fills.length, turnover: round2(turnover) };
}

/**
 * Moves the book to a new IST day: closes leftover intraday positions, expires old day
 * orders, moves today's delivery buys into holdings and archives the day's numbers.
 */
export function rolloverTo(state: EngineState, day: string, fallbackPrices: PriceBook): EngineResult {
  if (day <= state.tradingDay) return { state, events: [] };
  let s = state;
  const events: EngineEvent[] = [];
  const prevDay = s.tradingDay;
  const closeTime = istTimestamp(prevDay, SESSION.close);

  const misOpen = Object.values(s.positions).some((p) => p.product === 'MIS' && p.netQty !== 0);
  if (misOpen && s.squaredOffDay !== prevDay) {
    const r = squareOffIntraday(
      s,
      prevDay,
      (sym) => fallbackPrices[sym] ?? null,
      istTimestamp(prevDay, parseHHMM(s.settings.squareOffTime)),
      'Squared off at last known price',
      fallbackPrices,
      true,
    );
    s = r.state;
    events.push(...r.events);
  }

  const exp = expireOrders(s, (o) => o.sessionDay !== null && o.sessionDay < day, closeTime);
  s = exp.state;
  events.push(...exp.events);

  const holdings: Record<string, Holding> = { ...s.holdings };
  for (const p of Object.values(s.positions)) {
    if (p.product !== 'CNC' || p.netQty <= 0) continue;
    const h = holdings[p.instrument.symbol];
    if (h) {
      const qty = h.qty + p.netQty;
      holdings[p.instrument.symbol] = { ...h, qty, avgPrice: round2((h.qty * h.avgPrice + p.netQty * p.avgPrice) / qty) };
    } else {
      holdings[p.instrument.symbol] = { instrument: p.instrument, qty: p.netQty, avgPrice: round2(p.avgPrice), since: prevDay };
    }
  }

  const record = summarizeDay(s, prevDay);
  const dayLog = record ? [record, ...s.dayLog.filter((d) => d.day !== prevDay)].slice(0, KEEP_DAYS) : s.dayLog;

  const active = s.orders.filter(isActive);
  const closed = s.orders.filter((o) => !isActive(o)).slice(0, KEEP_CLOSED_ORDERS);

  s = {
    ...s,
    holdings,
    positions: {},
    dayLog,
    tradingDay: day,
    orders: [...active, ...closed].sort((a, b) => b.placedAt - a.placedAt),
    fills: s.fills.slice(0, KEEP_FILLS),
  };
  return { state: s, events };
}

/* ------------------------------------------------------------------ */
/* Live processing                                                      */
/* ------------------------------------------------------------------ */

/** Runs on every price refresh: matches orders, squares off intraday, expires day orders. */
export function processQuotes(state: EngineState, quotes: Record<string, Quote>, now: number): EngineResult {
  let s = state;
  const events: EngineEvent[] = [];
  const prices = pricesFromQuotes(quotes);
  const today = istDayKey(now);
  if (today > s.tradingDay) {
    const r = rolloverTo(s, today, prices);
    s = r.state;
    events.push(...r.events);
  }

  const sqMin = parseHHMM(s.settings.squareOffTime);
  const nowMin = istParts(now).minuteOfDay;

  const pending = s.orders.filter(isActive).sort((a, b) => a.placedAt - b.placedAt);
  for (const p of pending) {
    const q = quotes[p.instrument.symbol];
    if (!q || !isLiveQuote(q, now)) continue;
    let o = findOrder(s, p.id);
    if (!o || !isActive(o)) continue;
    if (o.product === 'MIS' && nowMin >= sqMin) continue;
    if (o.sessionDay === null) {
      s = patchOrder(s, o.id, { sessionDay: today, evaluated: false, updatedAt: now });
      o = findOrder(s, o.id) as Order;
    }
    if (o.sessionDay !== today) continue;
    const r = matchOrder(s, o, { o: q.ltp, h: q.ltp, l: q.ltp }, 'tick', now, prices);
    s = r.state;
    events.push(...r.events);
  }

  if (isWeekday(now) && nowMin >= sqMin && s.squaredOffDay !== today) {
    const hasMis =
      Object.values(s.positions).some((p) => p.product === 'MIS' && p.netQty !== 0) ||
      s.orders.some((o) => isActive(o) && o.product === 'MIS' && o.sessionDay === today);
    if (hasMis) {
      const priceOf = (sym: string): number | null => {
        const q = quotes[sym];
        if (!q) return null;
        if (isLiveQuote(q, now)) return q.ltp;
        // After the close, today's last price is the best available stand-in.
        if (nowMin >= SESSION.close && istDayKey(q.time) === today) return q.ltp;
        return null;
      };
      const r = squareOffIntraday(s, today, priceOf, now, `Auto square-off at ${formatHHMM(sqMin)}`, prices);
      s = r.state;
      events.push(...r.events);
    }
  }

  if (nowMin >= SESSION.close || !isWeekday(now)) {
    const r = expireOrders(s, (o) => o.sessionDay !== null && o.sessionDay <= today, now);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

/* ------------------------------------------------------------------ */
/* Catch-up replay                                                      */
/* ------------------------------------------------------------------ */

/**
 * Replays 1-minute candles for the time the app was closed, so limit and stop orders,
 * intraday square-off and day changes behave as if the app had been running.
 */
export function replayCandles(
  state: EngineState,
  series: Record<string, Candle[]>,
  fromTs: number,
  toTs: number,
  fallbackPrices: PriceBook,
): EngineResult {
  type Item = Candle & { sym: string; day: string };
  const items: Item[] = [];
  const lastClose: Record<string, { day: string; c: number }> = {};

  for (const [sym, candles] of Object.entries(series)) {
    for (const c of candles) {
      const end = c.t + MINUTE;
      if (end <= fromTs) {
        lastClose[sym] = { day: istDayKey(c.t), c: c.c };
        continue;
      }
      if (end > toTs) continue;
      const m = istParts(c.t).minuteOfDay;
      if (m < SESSION.open || m >= SESSION.close) continue;
      items.push({ ...c, sym, day: istDayKey(c.t) });
    }
  }
  if (items.length === 0) return { state, events: [] };
  items.sort((a, b) => a.t - b.t || (a.sym < b.sym ? -1 : a.sym > b.sym ? 1 : 0));

  let s = state;
  const events: EngineEvent[] = [];
  const priceOfDay = (day: string) => (sym: string) => {
    const lc = lastClose[sym];
    if (lc && lc.day === day) return lc.c;
    return null;
  };
  const merged = (): PriceBook => {
    const out: PriceBook = { ...fallbackPrices };
    for (const [k, v] of Object.entries(lastClose)) out[k] = v.c;
    return out;
  };

  const finishDay = (day: string) => {
    const sqTs = istTimestamp(day, parseHHMM(s.settings.squareOffTime));
    if (s.squaredOffDay !== day) {
      const hasMis =
        Object.values(s.positions).some((p) => p.product === 'MIS' && p.netQty !== 0) ||
        s.orders.some((o) => isActive(o) && o.product === 'MIS' && o.sessionDay === day);
      if (hasMis) {
        const fb = merged();
        const r = squareOffIntraday(
          s,
          day,
          (sym) => priceOfDay(day)(sym) ?? fb[sym] ?? null,
          sqTs,
          `Auto square-off at ${formatHHMM(parseHHMM(s.settings.squareOffTime))}`,
          fb,
          true,
        );
        s = r.state;
        events.push(...r.events);
      }
    }
    const r = expireOrders(s, (o) => o.sessionDay !== null && o.sessionDay <= day, istTimestamp(day, SESSION.close));
    s = r.state;
    events.push(...r.events);
  };

  const toDay = istDayKey(toTs);
  let i = 0;
  while (i < items.length) {
    const day = items[i].day;
    if (day > s.tradingDay) {
      if (s.tradingDay < day) finishDay(s.tradingDay);
      const r = rolloverTo(s, day, merged());
      s = r.state;
      events.push(...r.events);
    }
    const sqTs = istTimestamp(day, parseHHMM(s.settings.squareOffTime));

    while (i < items.length && items[i].day === day) {
      const c = items[i++];
      if (c.t >= sqTs && s.squaredOffDay !== day) {
        const hasMis =
          Object.values(s.positions).some((p) => p.product === 'MIS' && p.netQty !== 0) ||
          s.orders.some((o) => isActive(o) && o.product === 'MIS' && o.sessionDay === day);
        if (hasMis) {
          const fb = merged();
          const r = squareOffIntraday(
            s,
            day,
            (sym) => priceOfDay(day)(sym),
            sqTs,
            `Auto square-off at ${formatHHMM(parseHHMM(s.settings.squareOffTime))}`,
            fb,
          );
          s = r.state;
          events.push(...r.events);
        }
      }

      const orders = s.orders
        .filter((o) => isActive(o) && o.instrument.symbol === c.sym)
        .sort((a, b) => a.placedAt - b.placedAt);
      for (const o0 of orders) {
        let o = findOrder(s, o0.id);
        if (!o || !isActive(o)) continue;
        if (o.product === 'MIS' && c.t >= sqTs) continue;
        if (c.t < minuteFloor(o.placedAt) + MINUTE) continue;
        if (o.sessionDay === null) {
          s = patchOrder(s, o.id, { sessionDay: day, evaluated: false, updatedAt: c.t });
          o = findOrder(s, o.id) as Order;
        }
        if (o.sessionDay !== day) continue;
        const r = matchOrder(s, o, { o: c.o, h: c.h, l: c.l }, 'bar', c.t + 30_000, merged());
        s = r.state;
        events.push(...r.events);
      }
      lastClose[c.sym] = { day, c: c.c };
    }

    const dayEnded = day < toDay || toTs >= istTimestamp(day, SESSION.close);
    if (dayEnded) finishDay(day);
  }
  return { state: s, events };
}
