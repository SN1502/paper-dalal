export type Exchange = 'NSE' | 'BSE';
export type Side = 'BUY' | 'SELL';
/** CNC = delivery, MIS = intraday (auto squared off). */
export type Product = 'CNC' | 'MIS';
export type OrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
export type OrderStatus = 'OPEN' | 'TRIGGER_PENDING' | 'COMPLETE' | 'CANCELLED' | 'REJECTED';

export interface Instrument {
  /** Yahoo Finance symbol, e.g. RELIANCE.NS, 500325.BO, ^NSEI */
  symbol: string;
  /** Exchange trading symbol shown to the user, e.g. RELIANCE */
  tradingSymbol: string;
  exchange: Exchange;
  name: string;
  isIndex?: boolean;
}

/** A price snapshot from the market data feed. */
export interface Quote {
  symbol: string;
  ltp: number;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  week52High: number | null;
  week52Low: number | null;
  /** Exchange time of the last trade (epoch ms). 0 when unknown. */
  time: number;
  /** When the app received it (epoch ms). */
  fetchedAt: number;
  source: 'yahoo' | 'google';
  name: string | null;
}

export interface Candle {
  t: number; // epoch ms, start of the bar
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Charges {
  brokerage: number;
  stt: number;
  exchange: number;
  sebi: number;
  stamp: number;
  gst: number;
  dp: number;
  total: number;
}

export interface Order {
  id: string;
  instrument: Instrument;
  side: Side;
  product: Product;
  type: OrderType;
  qty: number;
  /** Limit price for LIMIT and SL orders. */
  price: number | null;
  /** Trigger price for SL and SL-M orders. */
  triggerPrice: number | null;
  status: OrderStatus;
  /** Placed while the market was closed; becomes live at the next session. */
  amo: boolean;
  /** IST date of the session this order is live in. null = waiting for the next session. */
  sessionDay: string | null;
  /** True once the order has been checked against at least one price in its session. */
  evaluated: boolean;
  /** Funds reserved while the order is pending. */
  blockedAmount: number;
  placedAt: number;
  updatedAt: number;
  triggeredAt: number | null;
  filledAt: number | null;
  avgPrice: number | null;
  filledQty: number;
  /** Rejection, cancellation or expiry reason. */
  message: string | null;
  source: 'USER' | 'SQUARE_OFF';
}

export interface Fill {
  id: string;
  orderId: string;
  instrument: Instrument;
  side: Side;
  product: Product;
  qty: number;
  price: number;
  time: number;
  tradingDay: string;
  charges: Charges;
  /** Gross realized P&L booked by this fill (before charges). */
  realizedPnl: number;
  note: string | null;
}

/** A day position (intraday or today's delivery buys), netted per instrument + product. */
export interface Position {
  key: string;
  instrument: Instrument;
  product: Product;
  netQty: number;
  /** Average price of the open quantity. */
  avgPrice: number;
  buyQty: number;
  buyValue: number;
  sellQty: number;
  sellValue: number;
  /** Gross realized P&L for the day on this position. */
  realizedPnl: number;
  /** Margin held for an open MIS position. */
  blockedMargin: number;
}

export interface Holding {
  instrument: Instrument;
  qty: number;
  avgPrice: number;
  /** IST date the first lot entered the demat (for display). */
  since: string;
}

export interface DayRecord {
  day: string;
  realizedPnl: number;
  charges: number;
  trades: number;
  turnover: number;
}

export interface Settings {
  startingCapital: number;
  /** Intraday leverage. 5 means 20% margin. */
  misLeverage: number;
  /** IST time when intraday positions are squared off, "HH:MM". */
  squareOffTime: string;
  /** Seconds between price refreshes while the market is open. */
  refreshSeconds: number;
  /** Adverse slippage applied to market and stop-loss-market fills, in basis points. */
  slippageBps: number;
  /** Depository charge per scrip per day when selling delivery holdings (incl. GST). */
  dpChargePerScrip: number;
}

export interface Account {
  /** Ledger balance. Delivery buys debit the full value; intraday only books P&L and charges. */
  cash: number;
  realizedPnl: number;
  chargesPaid: number;
  createdAt: number;
}

export interface EngineState {
  schemaVersion: 1;
  account: Account;
  settings: Settings;
  /** Newest first. */
  orders: Order[];
  /** Newest first. */
  fills: Fill[];
  positions: Record<string, Position>;
  /** Keyed by instrument symbol. */
  holdings: Record<string, Holding>;
  watchlist: Instrument[];
  /** Closed trading days, newest first. */
  dayLog: DayRecord[];
  /** IST date that `positions` belong to. */
  tradingDay: string;
  /** Last IST date on which intraday square-off ran. */
  squaredOffDay: string | null;
}

export type EngineEventKind = 'fill' | 'reject' | 'trigger' | 'cancel' | 'expire' | 'squareoff' | 'info';

export interface EngineEvent {
  id: string;
  kind: EngineEventKind;
  title: string;
  body: string;
  side?: Side;
  orderId?: string;
}

export interface OrderInput {
  instrument: Instrument;
  side: Side;
  product: Product;
  type: OrderType;
  qty: number;
  price: number | null;
  triggerPrice: number | null;
}

export interface EngineResult {
  state: EngineState;
  events: EngineEvent[];
}
