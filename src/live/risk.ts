/**
 * Intraday limits for the live AI trader. Enforced in code after Claude decides.
 */
import type { ModelId } from '../ai/claude';

export interface LiveSettings {
  model: ModelId;
  /** Review open positions with Claude at least this often, in minutes. */
  checkInMinutes: number;
  /** Least time between two AI decisions, in minutes. */
  minGapMinutes: number;
  /** Live AI calls stop for the day at this estimated spend (USD). */
  dailyBudgetUsd: number;
  /** Most the account loses if an intraday stop is hit, as % of account value. */
  riskPerTradePct: number;
  /** Largest intraday position value, as % of account value. */
  maxNotionalPct: number;
  maxPositions: number;
  maxTradesPerDay: number;
  /** New intraday trades stop for the day once AI intraday P&L falls this far, as % of account value. */
  dailyLossLimitPct: number;
  allowShort: boolean;
  /** No new intraday entries after this IST time. */
  lastEntry: string;
  /** Minimum 20-day average traded value for intraday trades, ₹ crore. */
  minLiquidityCr: number;
  newsPulse: boolean;
  newsNse: boolean;
  keepAwake: boolean;
}

export const DEFAULT_LIVE_SETTINGS: LiveSettings = {
  model: 'claude-sonnet-5-5',
  checkInMinutes: 30,
  minGapMinutes: 3,
  dailyBudgetUsd: 3,
  riskPerTradePct: 0.5,
  maxNotionalPct: 20,
  maxPositions: 3,
  maxTradesPerDay: 6,
  dailyLossLimitPct: 2,
  allowShort: true,
  lastEntry: '14:45',
  minLiquidityCr: 25,
  newsPulse: true,
  newsNse: true,
  keepAwake: true,
};

export const INTRADAY_MIN_STOP_PCT = 0.3;
export const INTRADAY_MAX_STOP_PCT = 3;
export const INTRADAY_MIN_REWARD_RISK = 1.5;
export const INTRADAY_MIN_PRICE = 50;

export interface IntradayCheck {
  direction: 'long' | 'short';
  equity: number;
  /** Funds available for new margin. */
  available: number;
  leverage: number;
  entry: number;
  stop: number;
  target: number;
  liquidityCr: number | null;
  /** Open AI intraday positions (any symbol). */
  openPositions: number;
  /** AI intraday entries today. */
  tradesToday: number;
  /** AI intraday P&L today (realised + open), ₹. */
  pnlToday: number;
  alreadyInSymbol: boolean;
  minutesNow: number;
  isIndex: boolean;
  exchange: 'NSE' | 'BSE';
  settings: LiveSettings;
}

export type IntradaySizing = { ok: true; qty: number; notes: string[] } | { ok: false; reason: string };

const hhmm = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

export function intradayLossLimitHit(pnlToday: number, equity: number, s: LiveSettings): boolean {
  return pnlToday <= -(s.dailyLossLimitPct / 100) * equity;
}

export function sizeIntraday(c: IntradayCheck): IntradaySizing {
  const s = c.settings;
  if (c.isIndex) return { ok: false, reason: 'Indices can’t be traded.' };
  if (c.exchange !== 'NSE') return { ok: false, reason: 'Only NSE stocks are allowed for AI trades.' };
  if (c.minutesNow >= hhmm(s.lastEntry)) return { ok: false, reason: `No new intraday trades after ${s.lastEntry} IST.` };
  if (c.direction === 'short' && !s.allowShort) return { ok: false, reason: 'Short selling is switched off in Live settings.' };
  if (!(c.entry > 0)) return { ok: false, reason: 'No valid entry price.' };
  if (c.entry < INTRADAY_MIN_PRICE) return { ok: false, reason: `Intraday trades need a price of at least ₹${INTRADAY_MIN_PRICE}.` };
  if (intradayLossLimitHit(c.pnlToday, c.equity, s)) {
    return { ok: false, reason: `The daily intraday loss limit (${s.dailyLossLimitPct}% of the account) is reached. No new intraday trades today.` };
  }
  if (c.tradesToday >= s.maxTradesPerDay) return { ok: false, reason: `The limit of ${s.maxTradesPerDay} intraday trades a day is reached.` };
  if (c.openPositions >= s.maxPositions) return { ok: false, reason: `The limit of ${s.maxPositions} open intraday positions is reached.` };
  if (c.alreadyInSymbol) return { ok: false, reason: 'Already in an intraday position in this stock. Manage it instead.' };
  if (c.liquidityCr === null) return { ok: false, reason: 'Couldn’t verify liquidity.' };
  if (c.liquidityCr < s.minLiquidityCr) {
    return { ok: false, reason: `Too illiquid for intraday: ₹${c.liquidityCr.toFixed(1)} Cr average daily value, minimum ₹${s.minLiquidityCr} Cr.` };
  }

  const long = c.direction === 'long';
  const risk = long ? c.entry - c.stop : c.stop - c.entry;
  const reward = long ? c.target - c.entry : c.entry - c.target;
  if (!(risk > 0)) return { ok: false, reason: long ? 'Stop-loss must be below the entry.' : 'For a short, the stop-loss must be above the entry.' };
  if (!(reward > 0)) return { ok: false, reason: long ? 'Target must be above the entry.' : 'For a short, the target must be below the entry.' };
  const stopPct = (risk / c.entry) * 100;
  if (stopPct < INTRADAY_MIN_STOP_PCT) return { ok: false, reason: `Stop is only ${stopPct.toFixed(2)}% away; use at least ${INTRADAY_MIN_STOP_PCT}%.` };
  if (stopPct > INTRADAY_MAX_STOP_PCT) return { ok: false, reason: `Stop is ${stopPct.toFixed(2)}% away; intraday stops must be within ${INTRADAY_MAX_STOP_PCT}%.` };
  if (reward / risk < INTRADAY_MIN_REWARD_RISK) {
    return { ok: false, reason: `Reward-to-risk is ${(reward / risk).toFixed(2)}; it must be at least ${INTRADAY_MIN_REWARD_RISK}.` };
  }

  const notes: string[] = [];
  const byRisk = Math.floor(((s.riskPerTradePct / 100) * c.equity) / risk);
  const byNotional = Math.floor(((s.maxNotionalPct / 100) * c.equity) / c.entry);
  // Margin per share is entry/leverage plus a little for charges.
  const byMargin = Math.floor((Math.max(0, c.available) * 0.98) / (c.entry / Math.max(1, c.leverage)));
  let qty = Math.min(byRisk, byNotional, byMargin);
  if (qty === byRisk && byRisk < byNotional) notes.push(`Sized by the ${s.riskPerTradePct}% risk-per-trade limit.`);
  if (qty === byNotional && byNotional < byRisk) notes.push(`Capped at ${s.maxNotionalPct}% of account value.`);
  if (qty === byMargin && byMargin < Math.min(byRisk, byNotional)) notes.push('Sized down to the available margin.');
  qty = Math.max(0, qty);
  if (qty < 1) return { ok: false, reason: 'Not enough room for even one share within the risk, size and margin limits.' };
  return { ok: true, qty, notes };
}

/** Stops may only be tightened: raised for a long, lowered for a short, and stay on the right side of the price. */
export function checkStopTighten(direction: 'long' | 'short', oldStop: number | null, newStop: number, ltp: number): string | null {
  if (!(newStop > 0)) return 'Stop-loss must be above zero.';
  if (direction === 'long') {
    if (newStop >= ltp) return 'Stop-loss must stay below the current price.';
    if (oldStop !== null && newStop < oldStop) return 'Stops can only be tightened (moved up), not widened.';
  } else {
    if (newStop <= ltp) return 'For a short, the stop-loss must stay above the current price.';
    if (oldStop !== null && newStop > oldStop) return 'For a short, stops can only be tightened (moved down), not widened.';
  }
  return null;
}
