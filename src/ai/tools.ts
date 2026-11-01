/**
 * The tools Claude can call during a trading session, and their implementations.
 * Every trading tool goes through the app's own engine and risk limits.
 */
import { BENCHMARK, INDICES, SAFE_HAVEN_ETFS, sectorOf } from '../data/instruments';
import type { SearchHit } from '../data/yahoo';
import { activeGttFor, computeFunds, heldQty, isActive, pricesFromQuotes, roundToTick } from '../engine/engine';
import { accountSummary } from '../engine/selectors';
import type { Candle, EngineState, Instrument, Order, OrderInput, Quote } from '../engine/types';
import { round2 } from '../lib/format';
import { SESSION, formatDayKey, formatIstTime, istDayKey, istParts } from '../lib/time';
import { scoreFundamentals } from '../strategies/fundamentals';
import { round as roundTo } from '../strategies/math';
import {
  channel as channelOf,
  residualStats,
  threeMaSignal,
  twoMaSignal,
  type ScanResult,
  type StockSignal,
} from '../strategies/scan';
import { ibs, knnForecast, pivots } from '../strategies/single';
import type { FundamentalRecord } from '../strategies/store';
import { summarize, type TechnicalSummary } from './indicators';
import { checkStopUpdate, drawdownPaused, sizeBuy } from './risk';
import type { AiDecision, AiSettings, AiStep } from './types';

/** What the tools need from the app. Injected so the agent can be tested without a phone. */
export interface AgentEnv {
  now(): number;
  getState(): EngineState;
  quotes(): Record<string, Quote>;
  instrumentFor(symbol: string): Instrument;
  getQuote(inst: Instrument): Promise<Quote | null>;
  getDailyCandles(symbol: string): Promise<Candle[]>;
  search(query: string): Promise<SearchHit[]>;
  placeOrder(input: OrderInput): Promise<{ order: Order | null; error: string | null }>;
  updateGtt(id: string, patch: { stopPrice?: number | null; targetPrice?: number | null }): { error: string | null };
  marketStatus(): string;
  /** The day's strategy scan, computed in the app (refreshed if stale). */
  getScan(): Promise<ScanResult | null>;
  saveFundamentals(symbol: string, record: FundamentalRecord): void;
}

const emptySchema = { type: 'object', properties: {}, additionalProperties: false };

export const CLIENT_TOOLS = [
  {
    name: 'get_account',
    description:
      "The paper account right now: value, cash, available funds, the user's limits and how much room is left, every holding and today's positions (ai_managed marks the ones you opened) with their stop-loss/target exits, and open orders. Call this first.",
    input_schema: emptySchema,
  },
  {
    name: 'get_market_overview',
    description: 'Nifty 50, Bank Nifty and Sensex levels and day change, the Nifty 50 technical trend, market status and the current IST time.',
    input_schema: emptySchema,
  },
  {
    name: 'run_strategy_scan',
    description:
      "The app's daily quantitative scan of about 130 liquid NSE stocks using the strategies from Kakushadze & Serur, 151 Trading Strategies: market regime (§4.1.2 dual momentum), sector momentum rotation (§4.1 with the §4.1.1 MA filter), and a multifactor ranking (§3.6) built from 12-1 month price momentum (§3.1), residual momentum (§3.7), low volatility (§3.4) and sector momentum. Each stock shows factor percentiles (100 = best), its decile, moving-average signals (§3.11–3.13), its Donchian channel position (§3.15) and its 5-day sector-demeaned return (§3.9.1 mean reversion). Start new-idea research here.",
    input_schema: {
      type: 'object',
      properties: {
        sector: { type: 'string', description: 'Optional: only this sector.' },
        limit: { type: 'integer', minimum: 5, maximum: 40, description: 'How many top-ranked stocks to return (default 15).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'score_fundamentals',
    description:
      'Computes earnings momentum (SUE, §3.2: latest year-on-year EPS change over the standard deviation of the last 8 such changes) and value (book-to-price, §3.3) from numbers you read in a source such as the screener.in page. Pass quarterly EPS exactly as published, oldest first.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        quarterly_eps: { type: 'array', items: { type: 'number' }, minItems: 8, maxItems: 16, description: 'Quarterly EPS in ₹, oldest first; 12 quarters preferred.' },
        book_value_per_share: { type: 'number' },
        roce_pct: { type: 'number' },
        roe_pct: { type: 'number' },
        debt_to_equity: { type: 'number' },
        pe: { type: 'number' },
        promoter_holding_pct: { type: 'number' },
        pledged_pct: { type: 'number' },
        sales_growth_3y_pct: { type: 'number' },
        profit_growth_3y_pct: { type: 'number' },
        source: { type: 'string', description: 'Where the numbers came from (URL or site).' },
      },
      required: ['symbol', 'quarterly_eps'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_stocks',
    description: 'Find NSE symbols by company name or ticker. Returns symbols and names.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Company name or ticker, e.g. "Larsen" or "LT".' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_stock_snapshot',
    description:
      "Live price, indicators and strategy signals for one NSE stock from two years of daily data. Indicators: 20/50/200-day averages, RSI(14), MACD, ATR(14), returns, 52-week range, 20-day support and resistance, liquidity (average daily traded value in ₹ crore) and trend. Strategy signals from 151 Trading Strategies: the stock's row in the multifactor scan (§3.6), its moving-average signals (§3.11–3.13), daily and weekly pivot support and resistance (§3.14), its Donchian channel (§3.15), a 10-day KNN forecast with out-of-sample hit rate (§3.17), market beta, alpha and R² (§4.2–4.3) and IBS (§4.4). Also returns a screener.in URL to read with web_fetch for fundamentals.",
    input_schema: {
      type: 'object',
      properties: { symbol: { type: 'string', description: 'NSE symbol, e.g. "TCS" or "TCS.NS".' } },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'buy_stock',
    description:
      "Buy an NSE stock for a swing trade (delivery). A stop-loss and target are required and become a good-till-triggered exit. The app sizes the position within the user's limits and may reject the trade with a reason.",
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        order_type: { type: 'string', enum: ['MARKET', 'LIMIT'] },
        limit_price: { type: 'number', description: 'Required for LIMIT orders.' },
        stop_loss: { type: 'number', description: 'Price; 2–15% below the entry.' },
        target: { type: 'number', description: 'Price; at least 1.5× the risk above the entry.' },
        allocation_pct: { type: 'number', description: 'Optional preferred size as % of account value; capped by the limits.' },
        conviction: { type: 'integer', minimum: 1, maximum: 5 },
        thesis: { type: 'string', description: '2–4 sentences covering news, fundamentals and technicals.' },
        horizon_days: { type: 'integer', description: 'Expected holding period in trading days.' },
      },
      required: ['symbol', 'order_type', 'stop_loss', 'target', 'conviction', 'thesis'],
      additionalProperties: false,
    },
  },
  {
    name: 'sell_stock',
    description:
      "Sell all or part of a position you opened (ai_managed), at market. Use it when the thesis is broken or to book profit. You can't sell the user's own positions.",
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        quantity: { type: 'integer', description: 'Defaults to the whole position.' },
        reason: { type: 'string' },
      },
      required: ['symbol', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_exit',
    description: 'Change the stop-loss and/or target of a position you opened. A stop can only be raised (trailed), never lowered.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        stop_loss: { type: 'number' },
        target: { type: 'number' },
        reason: { type: 'string' },
      },
      required: ['symbol', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description: 'End the session. Give your market view in one or two sentences and a short summary of what you did and why. Always call this last.',
    input_schema: {
      type: 'object',
      properties: {
        market_view: { type: 'string' },
        summary: { type: 'string' },
        watch_next: { type: 'array', items: { type: 'string' }, description: 'Symbols to revisit next session.' },
      },
      required: ['market_view', 'summary'],
      additionalProperties: false,
    },
  },
] as const;

export type ClientToolName = (typeof CLIENT_TOOLS)[number]['name'];

export function isClientTool(name: string): name is ClientToolName {
  return CLIENT_TOOLS.some((t) => t.name === name);
}

/** Approximate delivery charges per rupee bought (STT, stamp, exchange, GST), for sizing. */
const DELIVERY_CHARGES_RATE = 0.0013;

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

export interface FinishData {
  marketView: string;
  summary: string;
  watchNext: string[];
}

export function normalizeSymbol(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase().replace(/^NSE:/, '');
  if (!s) return null;
  if (s.startsWith('^')) return s;
  if (s.endsWith('.BO')) return null;
  const base = s.endsWith('.NS') ? s.slice(0, -3) : s;
  if (!/^[A-Z0-9&-]{1,20}$/.test(base)) return null;
  return `${base}.NS`;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pctOf = (a: number | null | undefined, b: number | null | undefined) =>
  a !== null && a !== undefined && b ? round2(((a - b) / b) * 100) : null;

export class SessionTools {
  buysThisRun = 0;
  decisions: AiDecision[] = [];
  finished: FinishData | null = null;
  private candleCache = new Map<string, Candle[]>();
  private summaryCache = new Map<string, TechnicalSummary | null>();
  private lastScan: ScanResult | null = null;
  private scanLoaded = false;

  private async scan(): Promise<ScanResult | null> {
    if (!this.scanLoaded) {
      this.lastScan = await this.env.getScan().catch(() => null);
      this.scanLoaded = true;
    }
    return this.lastScan;
  }

  private async candles(symbol: string): Promise<Candle[]> {
    let c = this.candleCache.get(symbol);
    if (!c) {
      c = await this.env.getDailyCandles(symbol);
      this.candleCache.set(symbol, c);
    }
    return c;
  }

  constructor(
    private env: AgentEnv,
    private settings: AiSettings,
    private onStep: (step: AiStep) => void,
  ) {}

  private step(kind: AiStep['kind'], text: string) {
    this.onStep({ t: this.env.now(), kind, text });
  }

  private async technicals(symbol: string): Promise<TechnicalSummary | null> {
    if (this.summaryCache.has(symbol)) return this.summaryCache.get(symbol) ?? null;
    const candles = await this.candles(symbol);
    const s = summarize(candles);
    this.summaryCache.set(symbol, s);
    return s;
  }

  private aiPositionCount(state: EngineState): number {
    const set = new Set<string>();
    for (const h of Object.values(state.holdings)) if (h.ai && h.qty > 0) set.add(h.instrument.symbol);
    for (const p of Object.values(state.positions)) if (p.ai && p.netQty > 0) set.add(p.instrument.symbol);
    for (const o of state.orders) if (isActive(o) && o.source === 'AI' && o.side === 'BUY') set.add(o.instrument.symbol);
    return set.size;
  }

  async execute(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    try {
      switch (name as ClientToolName) {
        case 'get_account':
          this.step('tool', 'Reviewed the portfolio');
          await this.scan();
          return ok(this.account());
        case 'get_market_overview':
          this.step('tool', 'Checked the market backdrop');
          return ok(await this.marketOverview());
        case 'run_strategy_scan':
          return await this.strategyScan(input);
        case 'score_fundamentals':
          return await this.fundamentals(input);
        case 'search_stocks':
          return ok(await this.searchStocks(input));
        case 'get_stock_snapshot':
          return await this.snapshot(input);
        case 'buy_stock':
          return await this.buy(input);
        case 'sell_stock':
          return await this.sell(input);
        case 'update_exit':
          return await this.updateExit(input);
        case 'finish':
          this.finished = {
            marketView: String(input.market_view ?? '').slice(0, 600),
            summary: String(input.summary ?? '').slice(0, 2000),
            watchNext: Array.isArray(input.watch_next) ? input.watch_next.map(String).slice(0, 10) : [],
          };
          return ok({ ok: true });
        default:
          return fail(`Unknown tool ${name}.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Tool failed';
      this.step('error', `${name}: ${msg}`);
      return fail(msg);
    }
  }

  account() {
    const state = this.env.getState();
    const quotes = this.env.quotes();
    const sum = accountSummary(state, quotes);
    const s = this.settings;
    const exitsFor = (sym: string) =>
      activeGttFor(state, sym).map((g) => ({ qty: g.qty, stop_loss: g.stopPrice, target: g.targetPrice, set_by: g.source === 'AI' ? 'you' : 'user' }));
    return {
      now_ist: `${formatDayKey(istDayKey(this.env.now()))} ${formatIstTime(this.env.now(), false)}`,
      market_status: this.env.marketStatus(),
      account_value: sum.equity,
      starting_capital: sum.startingCapital,
      net_pnl_pct: round2(sum.netPnlPct),
      cash: sum.cash,
      available_to_trade: sum.available,
      limits: {
        max_position_value: round2((s.maxPositionPct / 100) * sum.equity),
        max_loss_per_trade: round2((s.riskPerTradePct / 100) * sum.equity),
        cash_reserve: round2((s.cashReservePct / 100) * sum.equity),
        max_ai_positions: s.maxPositions,
        ai_positions_open: this.aiPositionCount(state),
        new_buys_left_this_session: Math.max(0, s.maxNewPerRun - this.buysThisRun),
        min_liquidity_cr: s.minLiquidityCr,
        new_buys_paused_for_drawdown: drawdownPaused(sum.equity, sum.startingCapital, s),
      },
      holdings: Object.values(state.holdings).map((h) => {
        const q = quotes[h.instrument.symbol];
        return {
          symbol: h.instrument.tradingSymbol,
          name: h.instrument.name,
          qty: h.qty,
          avg_price: h.avgPrice,
          ltp: q?.ltp ?? null,
          pnl_pct: pctOf(q?.ltp, h.avgPrice),
          day_change_pct: pctOf(q?.ltp, q?.prevClose),
          held_since: h.since,
          ai_managed: !!h.ai,
          exits: exitsFor(h.instrument.symbol),
          scan_composite_percentile: this.lastScan?.stocks.find((x) => x.symbol === h.instrument.symbol)?.pct.composite ?? null,
        };
      }),
      todays_positions: Object.values(state.positions)
        .filter((p) => p.netQty !== 0)
        .map((p) => {
          const q = quotes[p.instrument.symbol];
          return {
            symbol: p.instrument.tradingSymbol,
            product: p.product === 'CNC' ? 'delivery' : 'intraday',
            qty: p.netQty,
            avg_price: round2(p.avgPrice),
            ltp: q?.ltp ?? null,
            pnl_pct: pctOf(q?.ltp, p.avgPrice),
            ai_managed: !!p.ai,
            exits: p.product === 'CNC' ? exitsFor(p.instrument.symbol) : [],
          };
        }),
      open_orders: state.orders.filter(isActive).map((o) => ({
        symbol: o.instrument.tradingSymbol,
        side: o.side,
        type: o.type,
        qty: o.qty,
        limit_price: o.price,
        trigger: o.triggerPrice,
        product: o.product,
        placed_by: o.source === 'AI' ? 'you' : 'user',
        queued_for_next_open: o.sessionDay === null,
      })),
    };
  }

  private async marketOverview() {
    const out: Record<string, unknown> = {
      now_ist: `${formatDayKey(istDayKey(this.env.now()))} ${formatIstTime(this.env.now(), false)}`,
      market_status: this.env.marketStatus(),
    };
    const quotes = await Promise.all(INDICES.map((i) => this.env.getQuote(i).catch(() => null)));
    out.indices = INDICES.map((i, k) => {
      const q = quotes[k];
      return { name: i.tradingSymbol, level: q?.ltp ?? null, day_change_pct: pctOf(q?.ltp, q?.prevClose) };
    });
    const t = await this.technicals('^NSEI').catch(() => null);
    if (t) {
      out.nifty_technicals = {
        trend: t.trend,
        sma50: t.sma50,
        sma200: t.sma200,
        rsi14: t.rsi14,
        return_pct: t.return_pct,
        pct_below_52w_high: t.pct_below_52w_high,
      };
    }
    return out;
  }

  private async strategyScan(input: Record<string, unknown>): Promise<ToolOutcome> {
    this.step('tool', 'Ran the 151 Trading Strategies scan');
    this.scanLoaded = false;
    const scan = await this.scan();
    if (!scan) return fail('The strategy scan is unavailable (price history could not be loaded). Fall back to get_stock_snapshot on individual stocks.');
    const limit = Math.min(40, Math.max(5, Math.round(num(input.limit) ?? 15)));
    const sector = typeof input.sector === 'string' && input.sector.trim() ? input.sector.trim().toLowerCase() : null;
    const pool = sector ? scan.stocks.filter((x) => x.sector.toLowerCase() === sector) : scan.stocks;
    const state = this.env.getState();
    const held = new Set([...Object.keys(state.holdings), ...Object.values(state.positions).filter((p) => p.netQty !== 0).map((p) => p.instrument.symbol)]);
    const pullbacks = scan.stocks
      .filter((x) => (x.pct.composite ?? 0) >= 60 && (x.pct.reversal ?? 0) >= 80 && x.aboveSma200 !== false)
      .slice(0, 8);
    return ok({
      method:
        'Long-only adaptation of 151 Trading Strategies on daily NSE data. Composite = average demeaned rank of four factors (§3.6): 12-1 month momentum (§3.1), residual momentum vs the Nifty 50 (§3.7), low volatility (§3.4, 1-year σ) and the stock’s sector 6-month momentum (§4.1). Percentiles run 0–100 across the universe, 100 = best. rev_5d_vs_sector is the §3.9.1 cluster-demeaned 5-day return; a negative value means it lagged its sector (a mean-reversion entry in an otherwise strong stock).',
      data_as_of: scan.asOfDay,
      computed_ist: `${formatDayKey(istDayKey(scan.computedAt))} ${formatIstTime(scan.computedAt, false)}`,
      coverage: `${scan.covered} of ${scan.universeSize} stocks ranked`,
      market_regime: scan.regime
        ? {
            state: scan.regime.state,
            nifty: scan.regime.close,
            sma100: scan.regime.sma100,
            sma200: scan.regime.sma200,
            nifty_6m_pct: pct1(scan.regime.ret6m),
            nifty_mom_12_1_pct: pct1(scan.regime.mom12_1),
            rule:
              scan.regime.state === 'risk-off'
                ? this.settings.regimeFilter
                  ? 'Dual momentum (§4.1.2): risk-off. New stock buys are blocked; only GOLDBEES/SILVERBEES may be bought.'
                  : 'Dual momentum (§4.1.2): risk-off. The user has turned the filter off; be very selective and favour low volatility.'
                : scan.regime.state === 'mixed'
                  ? 'Mixed: the index is between its 100- and 200-day averages. Be selective; prefer top-decile, low-volatility names.'
                  : 'Risk-on: momentum strategies are favoured.',
          }
        : 'unknown',
      sectors: scan.sectors.map((x) => ({
        rank: x.rank,
        sector: x.sector,
        stocks: x.members,
        ret_6m_pct: pct1(x.ret6m),
        ret_12m_pct: pct1(x.ret12m),
        above_ma100: x.aboveMa100,
        above_ma200: x.aboveMa200,
      })),
      top_ranked: pool.slice(0, limit).map((x) => ({ ...scanRow(x), you_or_user_hold_it: held.has(x.symbol) })),
      pullbacks_in_leaders: sector ? undefined : pullbacks.map((x) => scanRow(x)),
    });
  }

  private async singleStockSignals(sym: string, price: number) {
    const out: Record<string, unknown> = {};
    const scan = await this.scan();
    const row = scan?.stocks.find((x) => x.symbol === sym);
    out.scan = row ? scanRow(row) : sectorOf(sym) ? 'Not ranked today (insufficient history).' : 'Not in the scanned universe.';
    const candles = await this.candles(sym).catch(() => [] as Candle[]);
    if (candles.length < 30) return { ...out, note: 'Not enough daily history for single-stock signals.' };
    const now = this.env.now();
    const last = candles[candles.length - 1];
    const partial = istDayKey(last.t) === istDayKey(now) && istParts(now).minuteOfDay < SESSION.close;
    const completed = partial ? candles.slice(0, -1) : candles;
    const closes = candles.map((c) => c.c);
    const pv = pivots(completed, price);
    const knn = knnForecast(candles, 10);
    out.ma_10_30 = twoMaSignal(closes);
    out.ma_3_10_21 = threeMaSignal(closes);
    out.pivots = pv;
    out.channel_20d = channelOf(closes);
    out.ibs_last_day = ibs(completed);
    out.knn_10d = knn
      ? {
          forecast_pct: roundTo(knn.forecast * 100, 2),
          signal: knn.signal,
          validation_hit_rate: knn.cvHitRate,
          validation_up_share: knn.cvUpShare,
          validation_correlation: knn.cvCorrelation,
          note: 'Treat as weak evidence unless the hit rate clearly beats the up share.',
        }
      : 'Not enough history';
    if (!row && sym !== BENCHMARK) {
      const bench = await this.candles(BENCHMARK).catch(() => [] as Candle[]);
      if (bench.length > 260) {
        const bmap = new Map(bench.map((b) => [istDayKey(b.t), b.c]));
        const pairs = candles.filter((c) => bmap.has(istDayKey(c.t)));
        const st = residualStats(pairs.map((c) => c.c), pairs.map((c) => bmap.get(istDayKey(c.t)) as number));
        out.market_regression = {
          beta: st.beta !== null ? roundTo(st.beta, 2) : null,
          alpha_annual_pct: st.alpha !== null ? roundTo(st.alpha * 100, 2) : null,
          r2: st.r2 !== null ? roundTo(st.r2, 3) : null,
          residual_momentum: st.resMom !== null ? roundTo(st.resMom, 3) : null,
        };
      }
    } else if (row) {
      out.market_regression = {
        beta: row.beta,
        alpha_annual_pct: pct1(row.alpha),
        r2: row.r2,
        residual_momentum: row.resMom,
      };
    }
    return out;
  }

  private async fundamentals(input: Record<string, unknown>): Promise<ToolOutcome> {
    const sym = normalizeSymbol(input.symbol);
    if (!sym) return fail('Give an NSE symbol such as "TCS".');
    const inst = this.env.instrumentFor(sym);
    const eps = Array.isArray(input.quarterly_eps) ? input.quarterly_eps.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : [];
    if (eps.length < 8) return fail('Pass at least 8 quarters of EPS, oldest first.');
    const q = await this.env.getQuote(inst);
    if (!q) return fail('No live price for this symbol.');
    const score = scoreFundamentals({ quarterlyEps: eps, bookValuePerShare: num(input.book_value_per_share), price: q.ltp });
    const extras: Record<string, number | string | null> = {};
    for (const k of ['roce_pct', 'roe_pct', 'debt_to_equity', 'pe', 'promoter_holding_pct', 'pledged_pct', 'sales_growth_3y_pct', 'profit_growth_3y_pct']) {
      const v = num(input[k]);
      if (v !== null) extras[k] = v;
    }
    this.env.saveFundamentals(sym, { score, at: this.env.now(), source: typeof input.source === 'string' ? input.source.slice(0, 200) : null, extras });
    this.step('tool', `Scored fundamentals for ${inst.tradingSymbol}: SUE ${score.sue ?? '—'}, B/P ${score.bookToPrice ?? '—'}`);
    return ok({
      symbol: inst.tradingSymbol,
      price: q.ltp,
      sue: score.sue,
      sue_label: score.sueLabel,
      latest_yoy_eps_change: score.latestUnexpected,
      quarters_in_sue: score.unexpectedQuarters,
      book_to_price: score.bookToPrice,
      earnings_yield_pct: score.earningsYield !== null ? roundTo(score.earningsYield * 100, 2) : null,
      trailing_eps: score.trailingEps,
      notes: score.notes,
      guide:
        'SUE above about 1 means earnings are beating their own trend (§3.2 buys the top decile; the paper holds about 6 months). Book-to-price has no universal threshold: compare it with sector peers and the stock’s history (§3.3 buys the top decile).',
    });
  }

  private async searchStocks(input: Record<string, unknown>) {
    const q = String(input.query ?? '').trim();
    if (!q) return { results: [] };
    this.step('tool', `Looked up “${q.slice(0, 40)}”`);
    const hits = await this.env.search(q);
    return {
      results: hits
        .filter((h) => h.exchange === 'NSE')
        .slice(0, 8)
        .map((h) => ({ symbol: h.symbol.replace(/\.NS$/, ''), name: h.name })),
    };
  }

  private async snapshot(input: Record<string, unknown>): Promise<ToolOutcome> {
    const sym = normalizeSymbol(input.symbol);
    if (!sym) return fail('Give an NSE symbol such as "TCS". BSE-only symbols are not supported.');
    const inst = this.env.instrumentFor(sym);
    this.step('tool', `Checked price and technicals for ${inst.tradingSymbol}`);
    const [q, t] = await Promise.all([this.env.getQuote(inst), this.technicals(sym).catch(() => null)]);
    if (!q) return fail(`No price found for ${inst.tradingSymbol} on NSE. Check the symbol with search_stocks.`);
    const state = this.env.getState();
    const ts = inst.tradingSymbol;
    return ok({
      symbol: ts,
      name: q.name ?? inst.name,
      ltp: q.ltp,
      prev_close: q.prevClose,
      day_change_pct: pctOf(q.ltp, q.prevClose),
      day_high: q.high,
      day_low: q.low,
      volume: q.volume,
      last_trade_ist: q.time ? `${formatDayKey(istDayKey(q.time))} ${formatIstTime(q.time, false)}` : null,
      technicals: t ?? 'Not enough price history',
      strategy_signals: await this.singleStockSignals(sym, q.ltp),
      held_qty: heldQty(state, sym),
      fundamentals_url: inst.isIndex ? null : `https://www.screener.in/company/${encodeURIComponent(ts)}/consolidated/`,
    });
  }

  private async buy(input: Record<string, unknown>): Promise<ToolOutcome> {
    const sym = normalizeSymbol(input.symbol);
    if (!sym) return fail('Give an NSE symbol such as "TCS".');
    const inst = this.env.instrumentFor(sym);
    const type = input.order_type === 'LIMIT' ? 'LIMIT' : 'MARKET';
    const stopRaw = num(input.stop_loss);
    const targetRaw = num(input.target);
    const limitRaw = num(input.limit_price);
    const conviction = num(input.conviction);
    const thesis = String(input.thesis ?? '').trim().slice(0, 1200);
    if (stopRaw === null || targetRaw === null) return fail('stop_loss and target are required numbers.');
    if (type === 'LIMIT' && (limitRaw === null || limitRaw <= 0)) return fail('limit_price is required for a LIMIT order.');

    const reject = (reason: string, price: number | null): ToolOutcome => {
      this.decisions.push({
        symbol: inst.tradingSymbol,
        action: 'BUY',
        qty: null,
        price,
        stop: stopRaw,
        target: targetRaw,
        conviction,
        rationale: thesis,
        orderId: null,
        outcome: 'rejected',
        error: reason,
      });
      this.step('error', `Buy ${inst.tradingSymbol} rejected: ${reason}`);
      return { content: JSON.stringify({ status: 'rejected', reason }), isError: true };
    };

    const q = await this.env.getQuote(inst);
    if (!q) return reject('No live price for this symbol.', null);
    const t = await this.technicals(sym).catch(() => null);
    const entry = type === 'LIMIT' ? roundToTick(limitRaw as number, 'down') : q.ltp;
    const stop = roundToTick(stopRaw, 'down');
    const target = roundToTick(targetRaw, 'up');

    const state = this.env.getState();
    const quotes = this.env.quotes();
    const sum = accountSummary(state, quotes);
    const funds = computeFunds(state, pricesFromQuotes(quotes));
    const pendingBuy = state.orders.some((o) => isActive(o) && o.side === 'BUY' && o.instrument.symbol === sym);
    const misOpen = (state.positions[`${sym}|MIS`]?.netQty ?? 0) !== 0;

    const sizing = sizeBuy({
      equity: sum.equity,
      available: funds.available,
      startingCapital: sum.startingCapital,
      aiPositions: this.aiPositionCount(state),
      buysThisRun: this.buysThisRun,
      alreadyInvolved: heldQty(state, sym) > 0 || pendingBuy || misOpen,
      exchange: inst.exchange,
      isIndex: !!inst.isIndex,
      entry,
      stop,
      target,
      liquidityCr: t ? t.avg_traded_value_20d_cr : null,
      requestedAllocationPct: num(input.allocation_pct),
      requestedQty: null,
      chargesRate: DELIVERY_CHARGES_RATE,
      settings: this.settings,
      regime: (await this.scan())?.regime?.state ?? null,
      isSafeHaven: SAFE_HAVEN_ETFS.includes(sym),
    });
    if (!sizing.ok) return reject(sizing.reason, entry);

    const res = await this.env.placeOrder({
      instrument: inst,
      side: 'BUY',
      product: 'CNC',
      type,
      qty: sizing.qty,
      price: type === 'LIMIT' ? entry : null,
      triggerPrice: null,
      source: 'AI',
      bracket: { stopPrice: stop, targetPrice: target },
    });
    if (res.error || !res.order) return reject(res.error ?? 'Order failed.', entry);
    const o = res.order;
    if (o.status === 'REJECTED') return reject(o.message ?? 'Order rejected.', entry);

    this.buysThisRun++;
    const filled = o.status === 'COMPLETE';
    this.decisions.push({
      symbol: inst.tradingSymbol,
      action: 'BUY',
      qty: o.qty,
      price: filled ? o.avgPrice : entry,
      stop,
      target,
      conviction,
      rationale: thesis,
      orderId: o.id,
      outcome: filled ? 'filled' : 'queued',
      error: null,
    });
    this.step(
      'order',
      `${filled ? 'Bought' : 'Placed buy for'} ${o.qty} ${inst.tradingSymbol}${filled ? ` at ₹${o.avgPrice}` : ''} · SL ₹${stop} · target ₹${target}`,
    );
    return ok({
      status: filled ? 'filled' : 'queued',
      symbol: inst.tradingSymbol,
      qty: o.qty,
      fill_price: filled ? o.avgPrice : null,
      limit_price: type === 'LIMIT' ? entry : null,
      stop_loss: stop,
      target,
      position_value: round2(o.qty * (filled ? (o.avgPrice as number) : entry)),
      notes: [
        ...sizing.notes,
        filled ? 'Exit (stop-loss and target) is active.' : 'Exit becomes active when the order fills.',
        o.sessionDay === null ? 'Market is closed; the order executes from the next open.' : '',
      ].filter(Boolean),
    });
  }

  private async sell(input: Record<string, unknown>): Promise<ToolOutcome> {
    const sym = normalizeSymbol(input.symbol);
    if (!sym) return fail('Give an NSE symbol such as "TCS".');
    const inst = this.env.instrumentFor(sym);
    const reason = String(input.reason ?? '').trim().slice(0, 800);
    const state = this.env.getState();
    const h = state.holdings[sym];
    const p = state.positions[`${sym}|CNC`];
    const aiHeld = (h?.ai ? h.qty : 0) + (p?.ai ? Math.max(0, p.netQty) : 0);
    if (aiHeld <= 0) {
      const userHeld = heldQty(state, sym) > 0;
      return fail(userHeld ? `${inst.tradingSymbol} belongs to the user, not to you. Leave it alone.` : `You don't hold ${inst.tradingSymbol}.`);
    }
    const reqQty = num(input.quantity);
    const qty = Math.min(aiHeld, reqQty !== null && reqQty > 0 ? Math.floor(reqQty) : aiHeld);
    const res = await this.env.placeOrder({
      instrument: inst,
      side: 'SELL',
      product: 'CNC',
      type: 'MARKET',
      qty,
      price: null,
      triggerPrice: null,
      source: 'AI',
    });
    const o = res.order;
    if (res.error || !o || o.status === 'REJECTED') {
      const msg = res.error ?? o?.message ?? 'Order failed.';
      this.decisions.push({ symbol: inst.tradingSymbol, action: 'SELL', qty, price: null, stop: null, target: null, conviction: null, rationale: reason, orderId: o?.id ?? null, outcome: 'rejected', error: msg });
      this.step('error', `Sell ${inst.tradingSymbol} rejected: ${msg}`);
      return { content: JSON.stringify({ status: 'rejected', reason: msg }), isError: true };
    }
    const filled = o.status === 'COMPLETE';
    this.decisions.push({
      symbol: inst.tradingSymbol,
      action: 'SELL',
      qty,
      price: o.avgPrice,
      stop: null,
      target: null,
      conviction: null,
      rationale: reason,
      orderId: o.id,
      outcome: filled ? 'filled' : 'queued',
      error: null,
    });
    this.step('order', `${filled ? 'Sold' : 'Placed sell for'} ${qty} ${inst.tradingSymbol}${filled ? ` at ₹${o.avgPrice}` : ''}`);
    return ok({ status: filled ? 'filled' : 'queued', symbol: inst.tradingSymbol, qty, fill_price: o.avgPrice });
  }

  private async updateExit(input: Record<string, unknown>): Promise<ToolOutcome> {
    const sym = normalizeSymbol(input.symbol);
    if (!sym) return fail('Give an NSE symbol such as "TCS".');
    const inst = this.env.instrumentFor(sym);
    const reason = String(input.reason ?? '').trim().slice(0, 800);
    const g = activeGttFor(this.env.getState(), sym).find((x) => x.source === 'AI');
    if (!g) return fail(`No active exit that you set on ${inst.tradingSymbol}.`);
    const q = await this.env.getQuote(inst);
    if (!q) return fail('No live price for this symbol.');
    const stopIn = num(input.stop_loss);
    const targetIn = num(input.target);
    if (stopIn === null && targetIn === null) return fail('Give a new stop_loss, target, or both.');
    const stop = stopIn !== null ? roundToTick(stopIn, 'down') : g.stopPrice;
    const target = targetIn !== null ? roundToTick(targetIn, 'up') : g.targetPrice;
    if (stopIn !== null) {
      const err = checkStopUpdate(g.stopPrice, stop as number, q.ltp);
      if (err) return fail(err);
    }
    if (target !== null && target <= q.ltp) return fail('Target must be above the current price.');
    const r = this.env.updateGtt(g.id, { stopPrice: stop, targetPrice: target });
    if (r.error) return fail(r.error);
    this.decisions.push({
      symbol: inst.tradingSymbol,
      action: 'UPDATE_EXIT',
      qty: g.qty,
      price: q.ltp,
      stop,
      target,
      conviction: null,
      rationale: reason,
      orderId: null,
      outcome: 'updated',
      error: null,
    });
    this.step('order', `Updated exit for ${inst.tradingSymbol}: SL ₹${stop ?? '—'} · target ₹${target ?? '—'}`);
    return ok({ status: 'updated', symbol: inst.tradingSymbol, stop_loss: stop, target });
  }
}

function pct1(x: number | null): number | null {
  return x === null ? null : roundTo(x * 100, 2);
}

/** Compact view of one scanned stock for the model. Returns are in %. */
export function scanRow(s: StockSignal) {
  return {
    symbol: s.tradingSymbol,
    name: s.name,
    sector: s.sector,
    price: s.price,
    decile: s.decile,
    percentiles: s.pct,
    mom_12_1_pct: pct1(s.mom12_1),
    mom_risk_adjusted: s.momRiskAdj,
    residual_momentum: s.resMom,
    volatility_pct: pct1(s.vol),
    beta: s.beta,
    ret_1m_pct: pct1(s.ret1m),
    ret_6m_pct: pct1(s.ret6m),
    rev_5d_vs_sector_pct: pct1(s.rev5dDemeaned),
    above_sma: { '50': s.aboveSma50, '100': s.aboveSma100, '200': s.aboveSma200 },
    ma_10_30: s.ma2,
    ma_3_10_21: s.ma3,
    channel_20d: s.channel ? { low: s.channel.low, high: s.channel.high, position: s.channel.position } : null,
    tags: s.tags,
  };
}

function ok(value: unknown): ToolOutcome {
  return { content: JSON.stringify(value), isError: false };
}

function fail(message: string): ToolOutcome {
  return { content: JSON.stringify({ error: message }), isError: true };
}
