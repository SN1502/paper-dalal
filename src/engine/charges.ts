import { round2 } from '../lib/format';
import type { Charges, Exchange, Product, Side } from './types';

/**
 * Statutory charges and brokerage modelled on a discount broker's equity schedule
 * (Zerodha's published equity rates, checked Oct 2026). Rates are fractions of turnover.
 */
export const CHARGE_RATES = {
  delivery: {
    brokerageRate: 0,
    brokerageCap: 0,
    sttBuy: 0.001, // 0.1% on buy
    sttSell: 0.001, // 0.1% on sell
    stampBuy: 0.00015, // 0.015% on buy
  },
  intraday: {
    brokerageRate: 0.0003, // 0.03% ...
    brokerageCap: 20, // ... or ₹20 per executed order, whichever is lower
    sttBuy: 0,
    sttSell: 0.00025, // 0.025% on sell
    stampBuy: 0.00003, // 0.003% on buy
  },
  exchangeTxn: { NSE: 0.0000307, BSE: 0.0000375 } as Record<Exchange, number>,
  sebiPerCrore: 10,
  gst: 0.18, // on brokerage + exchange + SEBI fees
} as const;

export interface ChargeInput {
  product: Product;
  side: Side;
  exchange: Exchange;
  qty: number;
  price: number;
  /** Depository charge to add (delivery sells from holdings only). */
  dpCharge?: number;
}

export function computeCharges(input: ChargeInput): Charges {
  const turnover = input.qty * input.price;
  const r = input.product === 'MIS' ? CHARGE_RATES.intraday : CHARGE_RATES.delivery;
  const brokerage = r.brokerageRate > 0 ? Math.min(turnover * r.brokerageRate, r.brokerageCap) : 0;
  const stt = turnover * (input.side === 'BUY' ? r.sttBuy : r.sttSell);
  const exchange = turnover * CHARGE_RATES.exchangeTxn[input.exchange];
  const sebi = (turnover * CHARGE_RATES.sebiPerCrore) / 1e7;
  const stamp = input.side === 'BUY' ? turnover * r.stampBuy : 0;
  const gst = CHARGE_RATES.gst * (brokerage + exchange + sebi);
  const dp = input.dpCharge ?? 0;

  const c: Charges = {
    brokerage: round2(brokerage),
    stt: round2(stt),
    exchange: round2(exchange),
    sebi: round2(sebi),
    stamp: round2(stamp),
    gst: round2(gst),
    dp: round2(dp),
    total: 0,
  };
  c.total = round2(c.brokerage + c.stt + c.exchange + c.sebi + c.stamp + c.gst + c.dp);
  return c;
}

export const ZERO_CHARGES: Charges = {
  brokerage: 0,
  stt: 0,
  exchange: 0,
  sebi: 0,
  stamp: 0,
  gst: 0,
  dp: 0,
  total: 0,
};

export function addCharges(a: Charges, b: Charges): Charges {
  return {
    brokerage: round2(a.brokerage + b.brokerage),
    stt: round2(a.stt + b.stt),
    exchange: round2(a.exchange + b.exchange),
    sebi: round2(a.sebi + b.sebi),
    stamp: round2(a.stamp + b.stamp),
    gst: round2(a.gst + b.gst),
    dp: round2(a.dp + b.dp),
    total: round2(a.total + b.total),
  };
}
