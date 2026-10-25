import { round2 } from '../lib/format';
import { computeFunds, isActive, type PriceBook } from './engine';
import type { EngineState, Fill, Holding, Order, Position, Quote } from './types';

export interface PositionView {
  pos: Position;
  ltp: number | null;
  unrealized: number;
  /** realized + unrealized (gross, before charges) */
  pnl: number;
}

export function positionViews(state: EngineState, quotes: Record<string, Quote | undefined>): PositionView[] {
  return Object.values(state.positions)
    .map((pos) => {
      const ltp = quotes[pos.instrument.symbol]?.ltp ?? null;
      const unrealized = pos.netQty !== 0 && ltp !== null ? pos.netQty * (ltp - pos.avgPrice) : 0;
      return { pos, ltp, unrealized: round2(unrealized), pnl: round2(pos.realizedPnl + unrealized) };
    })
    .sort((a, b) => {
      const ao = a.pos.netQty !== 0 ? 0 : 1;
      const bo = b.pos.netQty !== 0 ? 0 : 1;
      return ao - bo || a.pos.instrument.tradingSymbol.localeCompare(b.pos.instrument.tradingSymbol);
    });
}

export interface HoldingView {
  holding: Holding;
  ltp: number | null;
  prevClose: number | null;
  invested: number;
  current: number;
  pnl: number;
  pnlPct: number;
  dayChange: number;
  dayChangePct: number | null;
}

export function holdingViews(state: EngineState, quotes: Record<string, Quote | undefined>): HoldingView[] {
  return Object.values(state.holdings)
    .map((h) => {
      const q = quotes[h.instrument.symbol];
      const ltp = q?.ltp ?? null;
      const prevClose = q?.prevClose ?? null;
      const invested = h.qty * h.avgPrice;
      const current = ltp !== null ? h.qty * ltp : invested;
      const pnl = current - invested;
      const dayChange = ltp !== null && prevClose !== null ? h.qty * (ltp - prevClose) : 0;
      return {
        holding: h,
        ltp,
        prevClose,
        invested: round2(invested),
        current: round2(current),
        pnl: round2(pnl),
        pnlPct: invested > 0 ? (pnl / invested) * 100 : 0,
        dayChange: round2(dayChange),
        dayChangePct: ltp !== null && prevClose ? ((ltp - prevClose) / prevClose) * 100 : null,
      };
    })
    .sort((a, b) => b.current - a.current);
}

export interface AccountSummary {
  startingCapital: number;
  cash: number;
  available: number;
  misMargin: number;
  orderBlocks: number;
  holdingsInvested: number;
  holdingsValue: number;
  /** Today's delivery buys at market value. */
  cncPositionsValue: number;
  /** Open intraday mark-to-market. */
  misUnrealized: number;
  /** Total account value if everything were sold now (before exit charges). */
  equity: number;
  netPnl: number;
  netPnlPct: number;
  realizedPnl: number;
  chargesPaid: number;
  /** Today's P&L: holdings vs previous close plus day positions (gross). */
  dayPnl: number;
  fillsToday: number;
}

export function accountSummary(state: EngineState, quotes: Record<string, Quote | undefined>): AccountSummary {
  const prices: PriceBook = {};
  for (const [k, q] of Object.entries(quotes)) if (q) prices[k] = q.ltp;
  const funds = computeFunds(state, prices);

  let holdingsInvested = 0;
  let holdingsValue = 0;
  let holdingsDay = 0;
  for (const h of Object.values(state.holdings)) {
    const q = quotes[h.instrument.symbol];
    const ltp = q?.ltp ?? h.avgPrice;
    holdingsInvested += h.qty * h.avgPrice;
    holdingsValue += h.qty * ltp;
    if (q?.prevClose) holdingsDay += h.qty * (ltp - q.prevClose);
  }

  let cncPositionsValue = 0;
  let positionsDayPnl = 0;
  for (const p of Object.values(state.positions)) {
    const ltp = quotes[p.instrument.symbol]?.ltp ?? p.avgPrice;
    if (p.product === 'CNC' && p.netQty > 0) cncPositionsValue += p.netQty * ltp;
    positionsDayPnl += p.realizedPnl + (p.netQty !== 0 ? p.netQty * (ltp - p.avgPrice) : 0);
  }

  let fillsToday = 0;
  for (const f of state.fills) {
    if (f.tradingDay !== state.tradingDay) break;
    fillsToday++;
  }

  const equity = funds.cash + holdingsValue + cncPositionsValue + funds.misUnrealized;
  const netPnl = equity - state.settings.startingCapital;
  return {
    startingCapital: state.settings.startingCapital,
    cash: funds.cash,
    available: funds.available,
    misMargin: funds.misMargin,
    orderBlocks: funds.orderBlocks,
    holdingsInvested: round2(holdingsInvested),
    holdingsValue: round2(holdingsValue),
    cncPositionsValue: round2(cncPositionsValue),
    misUnrealized: funds.misUnrealized,
    equity: round2(equity),
    netPnl: round2(netPnl),
    netPnlPct: state.settings.startingCapital > 0 ? (netPnl / state.settings.startingCapital) * 100 : 0,
    realizedPnl: state.account.realizedPnl,
    chargesPaid: state.account.chargesPaid,
    dayPnl: round2(holdingsDay + positionsDayPnl),
    fillsToday,
  };
}

export function openOrders(state: EngineState): Order[] {
  return state.orders.filter(isActive);
}

export function closedOrders(state: EngineState): Order[] {
  return state.orders.filter((o) => !isActive(o));
}

export function groupByDay<T>(items: T[], dayOf: (t: T) => string): { day: string; items: T[] }[] {
  const out: { day: string; items: T[] }[] = [];
  for (const it of items) {
    const d = dayOf(it);
    const last = out[out.length - 1];
    if (last && last.day === d) last.items.push(it);
    else out.push({ day: d, items: [it] });
  }
  return out;
}

export function fillsForOrder(state: EngineState, orderId: string): Fill[] {
  return state.fills.filter((f) => f.orderId === orderId);
}

/** Symbols the app needs prices for. */
export function symbolsInUse(state: EngineState): string[] {
  const set = new Set<string>();
  for (const i of state.watchlist) set.add(i.symbol);
  for (const p of Object.values(state.positions)) set.add(p.instrument.symbol);
  for (const h of Object.values(state.holdings)) set.add(h.instrument.symbol);
  for (const o of state.orders) if (isActive(o)) set.add(o.instrument.symbol);
  return [...set];
}
