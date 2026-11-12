/** The AI's intraday book for today, for the live limits and the live screen. */
import type { AiRun } from '../ai/types';
import { isActive } from '../engine/engine';
import type { EngineState, Quote } from '../engine/types';
import { istDayKey } from '../lib/time';

export interface IntradayPosition {
  symbol: string;
  tradingSymbol: string;
  direction: 'long' | 'short';
  qty: number;
  avgPrice: number;
  ltp: number | null;
  pnl: number;
  pnlPct: number | null;
}

export interface IntradayStats {
  /** AI intraday entries today (filled or queued). */
  tradesToday: number;
  openPositions: number;
  /** Realised plus open P&L on AI intraday positions today, ₹ (before charges). */
  pnlToday: number;
  realised: number;
  positions: IntradayPosition[];
  /** Swing (delivery) buys the live trader made today. */
  swingBuysToday: number;
}

export function aiIntradayStats(state: EngineState, quotes: Record<string, Quote | undefined>, runs: AiRun[], now: number): IntradayStats {
  const day = istDayKey(now);
  let realised = 0;
  let open = 0;
  const positions: IntradayPosition[] = [];
  const openSymbols = new Set<string>();
  for (const p of Object.values(state.positions)) {
    if (p.product !== 'MIS' || !p.ai) continue;
    realised += p.realizedPnl;
    if (p.netQty === 0) continue;
    openSymbols.add(p.instrument.symbol);
    const ltp = quotes[p.instrument.symbol]?.ltp ?? null;
    const pnl = ltp !== null ? (ltp - p.avgPrice) * p.netQty : 0;
    positions.push({
      symbol: p.instrument.symbol,
      tradingSymbol: p.instrument.tradingSymbol,
      direction: p.netQty > 0 ? 'long' : 'short',
      qty: Math.abs(p.netQty),
      avgPrice: p.avgPrice,
      ltp,
      pnl: Math.round(pnl * 100) / 100,
      pnlPct: ltp !== null && p.avgPrice > 0 ? Math.round(((ltp / p.avgPrice - 1) * (p.netQty > 0 ? 1 : -1)) * 10_000) / 100 : null,
    });
  }
  open = positions.length;
  // An AI intraday order still waiting to fill holds a slot too.
  for (const o of state.orders) {
    if (isActive(o) && o.source === 'AI' && o.product === 'MIS' && !openSymbols.has(o.instrument.symbol)) {
      openSymbols.add(o.instrument.symbol);
      open++;
    }
  }
  let trades = 0;
  let swingBuys = 0;
  for (const r of runs) {
    if (r.day !== day) continue;
    for (const d of r.decisions) {
      if (d.outcome === 'rejected' || d.intent !== 'open') continue;
      if (d.product === 'MIS') trades++;
      else if (d.action === 'BUY') swingBuys++;
    }
  }
  const unrealised = positions.reduce((a, p) => a + p.pnl, 0);
  return {
    tradesToday: trades,
    openPositions: open,
    pnlToday: Math.round((realised + unrealised) * 100) / 100,
    realised: Math.round(realised * 100) / 100,
    positions,
    swingBuysToday: swingBuys,
  };
}
