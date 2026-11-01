import type { EngineState, Quote } from '../engine/types';
import { round2 } from '../lib/format';

export interface AiPerformance {
  openPositions: number;
  investedValue: number;
  currentValue: number;
  unrealized: number;
  /** Booked P&L of AI trades after charges (buy charges included). */
  realizedNet: number;
  trades: number;
  wins: number;
  losses: number;
}

/** What the AI's own trades have done so far. */
export function aiPerformance(state: EngineState, quotes: Record<string, Quote | undefined>): AiPerformance {
  const aiOrderIds = new Set(state.orders.filter((o) => o.source === 'AI').map((o) => o.id));
  for (const g of state.gtts) if (g.source === 'AI' && g.exitOrderId) aiOrderIds.add(g.exitOrderId);

  let realizedNet = 0;
  let trades = 0;
  let wins = 0;
  let losses = 0;
  for (const f of state.fills) {
    if (!aiOrderIds.has(f.orderId)) continue;
    realizedNet += f.realizedPnl - f.charges.total;
    if (f.side === 'SELL') {
      trades++;
      if (f.realizedPnl > 0) wins++;
      else if (f.realizedPnl < 0) losses++;
    }
  }

  let investedValue = 0;
  let currentValue = 0;
  let open = 0;
  for (const h of Object.values(state.holdings)) {
    if (!h.ai) continue;
    open++;
    const ltp = quotes[h.instrument.symbol]?.ltp ?? h.avgPrice;
    investedValue += h.qty * h.avgPrice;
    currentValue += h.qty * ltp;
  }
  for (const p of Object.values(state.positions)) {
    if (!p.ai || p.product !== 'CNC' || p.netQty <= 0) continue;
    if (!state.holdings[p.instrument.symbol]?.ai) open++;
    const ltp = quotes[p.instrument.symbol]?.ltp ?? p.avgPrice;
    investedValue += p.netQty * p.avgPrice;
    currentValue += p.netQty * ltp;
  }
  return {
    openPositions: open,
    investedValue: round2(investedValue),
    currentValue: round2(currentValue),
    unrealized: round2(currentValue - investedValue),
    realizedNet: round2(realizedNet),
    trades,
    wins,
    losses,
  };
}
