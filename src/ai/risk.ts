/**
 * Hard limits on what the AI may do. These run in code after Claude decides, so a
 * persuasive model output can never exceed the user's risk settings.
 */
import type { AiSettings } from './types';

export const MIN_STOP_PCT = 2;
export const MAX_STOP_PCT = 15;
export const MIN_REWARD_RISK = 1.5;
export const MIN_PRICE = 20;

export interface BuyCheck {
  equity: number;
  available: number;
  startingCapital: number;
  /** Distinct symbols the AI currently holds or has pending buys in. */
  aiPositions: number;
  buysThisRun: number;
  /** Any holding, day position or pending buy already in this symbol. */
  alreadyInvolved: boolean;
  exchange: 'NSE' | 'BSE';
  isIndex: boolean;
  entry: number;
  stop: number;
  target: number;
  liquidityCr: number | null;
  requestedAllocationPct: number | null;
  requestedQty: number | null;
  /** Estimated charges per rupee of turnover, to keep the reserve intact. */
  chargesRate: number;
  settings: AiSettings;
  /** Market regime from the strategy scan (§4.1.2); null if unknown. */
  regime: 'risk-on' | 'mixed' | 'risk-off' | null;
  /** Gold or silver ETF: still allowed in a risk-off regime. */
  isSafeHaven: boolean;
}

export type BuySizing = { ok: true; qty: number; notes: string[] } | { ok: false; reason: string };

export function drawdownPaused(equity: number, startingCapital: number, settings: AiSettings): boolean {
  return equity <= startingCapital * (1 - settings.maxDrawdownPct / 100);
}

export function sizeBuy(c: BuyCheck): BuySizing {
  const s = c.settings;
  if (c.isIndex) return { ok: false, reason: 'Indices can’t be bought. Use an index ETF such as NIFTYBEES.' };
  if (c.exchange !== 'NSE') return { ok: false, reason: 'Only NSE-listed stocks are allowed for AI trades.' };
  if (!(c.entry > 0)) return { ok: false, reason: 'No valid entry price.' };
  if (c.entry < MIN_PRICE) return { ok: false, reason: `Price is below ₹${MIN_PRICE}; penny stocks are excluded.` };
  if (drawdownPaused(c.equity, c.startingCapital, s)) {
    return { ok: false, reason: `New buys are paused: the account is down ${s.maxDrawdownPct}% or more from its starting capital.` };
  }
  if (s.regimeFilter && c.regime === 'risk-off' && !c.isSafeHaven) {
    return {
      ok: false,
      reason:
        'Market filter (dual momentum, §4.1.2): the Nifty 50 is below its 100- and 200-day averages, so only gold or silver ETFs (GOLDBEES, SILVERBEES) can be bought.',
    };
  }
  if (c.alreadyInvolved) return { ok: false, reason: 'Already holding or buying this stock. Manage the existing position instead.' };
  if (c.aiPositions >= s.maxPositions) return { ok: false, reason: `The limit of ${s.maxPositions} AI positions is reached.` };
  if (c.buysThisRun >= s.maxNewPerRun) return { ok: false, reason: `The limit of ${s.maxNewPerRun} new buys per run is reached.` };
  if (c.liquidityCr === null) return { ok: false, reason: 'Couldn’t verify liquidity (no price history).' };
  if (c.liquidityCr < s.minLiquidityCr) {
    return { ok: false, reason: `Too illiquid: ₹${c.liquidityCr.toFixed(1)} Cr average daily value, minimum is ₹${s.minLiquidityCr} Cr.` };
  }

  const stopPct = ((c.entry - c.stop) / c.entry) * 100;
  if (!(c.stop > 0) || c.stop >= c.entry) return { ok: false, reason: 'Stop-loss must be below the entry price.' };
  if (stopPct < MIN_STOP_PCT) return { ok: false, reason: `Stop-loss is only ${stopPct.toFixed(1)}% away; use at least ${MIN_STOP_PCT}% to avoid noise.` };
  if (stopPct > MAX_STOP_PCT) return { ok: false, reason: `Stop-loss is ${stopPct.toFixed(1)}% away; the maximum is ${MAX_STOP_PCT}%.` };
  const rr = (c.target - c.entry) / (c.entry - c.stop);
  if (!(c.target > c.entry) || rr < MIN_REWARD_RISK) {
    return { ok: false, reason: `Reward-to-risk is ${Number.isFinite(rr) ? rr.toFixed(2) : '0'}; it must be at least ${MIN_REWARD_RISK}.` };
  }

  const notes: string[] = [];
  const allocPct = Math.min(c.requestedAllocationPct ?? s.maxPositionPct, s.maxPositionPct);
  const byAllocation = Math.floor((allocPct / 100) * c.equity / c.entry);
  const byRisk = Math.floor(((s.riskPerTradePct / 100) * c.equity) / (c.entry - c.stop));
  const reserve = (s.cashReservePct / 100) * c.equity;
  const spendable = Math.max(0, c.available - reserve);
  const byCash = Math.floor(spendable / (c.entry * (1 + c.chargesRate)));
  let qty = Math.min(byAllocation, byRisk, byCash);
  if (qty === byRisk && byRisk < byAllocation) notes.push(`Sized by the ${s.riskPerTradePct}% risk-per-trade limit.`);
  if (qty === byCash && byCash < Math.min(byAllocation, byRisk)) notes.push(`Sized down to keep the ${s.cashReservePct}% cash reserve.`);
  if (c.requestedQty !== null && c.requestedQty > 0 && c.requestedQty < qty) {
    qty = Math.floor(c.requestedQty);
    notes.push('Used the smaller quantity requested.');
  }
  if (qty < 1) return { ok: false, reason: 'Not enough room for even one share within the size, risk and cash-reserve limits.' };
  return { ok: true, qty, notes };
}

/** A stop can only be tightened (moved up) on a long position. */
export function checkStopUpdate(oldStop: number | null, newStop: number, ltp: number): string | null {
  if (!(newStop > 0)) return 'Stop-loss must be above zero.';
  if (newStop >= ltp) return 'Stop-loss must stay below the current price.';
  if (oldStop !== null && newStop < oldStop) return 'Stops can only be tightened (moved up), not widened.';
  return null;
}
