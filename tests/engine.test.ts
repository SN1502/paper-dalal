import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeCharges } from '../src/engine/charges';
import {
  DEFAULT_SETTINGS,
  computeFunds,
  createInitialState,
  isOnTick,
  modifyOrder,
  placeOrder,
  processQuotes,
  replayCandles,
  rolloverTo,
  roundToTick,
} from '../src/engine/engine';
import { accountSummary } from '../src/engine/selectors';
import type { Candle, EngineState, Instrument, OrderInput, Quote } from '../src/engine/types';
import { parseGoogleQuote } from '../src/data/google';
import { istTimestamp, parseHHMM } from '../src/lib/time';

const MON = '2026-10-26'; // Monday
const TUE = '2026-10-27';
const SAT = '2026-10-31';
const at = (day: string, hhmm: string, sec = 0) => istTimestamp(day, parseHHMM(hhmm)) + sec * 1000;

const INFY: Instrument = { symbol: 'INFY.NS', tradingSymbol: 'INFY', exchange: 'NSE', name: 'Infosys' };
const SBIN: Instrument = { symbol: 'SBIN.NS', tradingSymbol: 'SBIN', exchange: 'NSE', name: 'SBI' };

function quote(inst: Instrument, ltp: number, time: number, prevClose = ltp): Quote {
  return {
    symbol: inst.symbol,
    ltp,
    prevClose,
    open: null,
    high: null,
    low: null,
    volume: null,
    week52High: null,
    week52Low: null,
    time,
    fetchedAt: time,
    source: 'yahoo',
    name: inst.name,
  };
}

function order(inst: Instrument, patch: Partial<OrderInput>): OrderInput {
  return { instrument: inst, side: 'BUY', product: 'CNC', type: 'MARKET', qty: 10, price: null, triggerPrice: null, ...patch };
}

function fresh(day = MON): EngineState {
  return createInitialState(at(day, '09:00'), DEFAULT_SETTINGS, [INFY]);
}

function place(s: EngineState, input: OrderInput, now: number, ltp: number) {
  const q = quote(input.instrument, ltp, now);
  return placeOrder(s, input, { now, quote: q, prices: { [input.instrument.symbol]: ltp } });
}

function tick(s: EngineState, inst: Instrument, ltp: number, now: number) {
  return processQuotes(s, { [inst.symbol]: quote(inst, ltp, now) }, now);
}

describe('charges', () => {
  it('intraday buy caps brokerage at ₹20 and charges stamp duty', () => {
    const c = computeCharges({ product: 'MIS', side: 'BUY', exchange: 'NSE', qty: 100, price: 1000 });
    assert.equal(c.brokerage, 20);
    assert.equal(c.stt, 0);
    assert.equal(c.exchange, 3.07);
    assert.equal(c.sebi, 0.1);
    assert.equal(c.stamp, 3);
    assert.equal(c.gst, 4.17);
    assert.equal(c.total, 30.34);
  });

  it('delivery sell charges 0.1% STT and the DP charge', () => {
    const c = computeCharges({ product: 'CNC', side: 'SELL', exchange: 'NSE', qty: 10, price: 1000, dpCharge: 15.34 });
    assert.equal(c.brokerage, 0);
    assert.equal(c.stt, 10);
    assert.equal(c.total, 25.72);
  });
});

describe('tick size', () => {
  it('uses 1 paisa below ₹250 and 5 paise above', () => {
    assert.equal(isOnTick(249.99), true);
    assert.equal(isOnTick(250.03), false);
    assert.equal(isOnTick(1500.05), true);
    assert.equal(roundToTick(1500.07, 'up'), 1500.1);
    assert.equal(roundToTick(1500.07, 'down'), 1500.05);
  });
});

describe('delivery orders', () => {
  it('fills a market buy at LTP, debits cash, and moves it to holdings next day', () => {
    const now = at(MON, '10:00');
    const r = place(fresh(), order(INFY, {}), now, 1500);
    assert.equal(r.error, null);
    assert.equal(r.order?.status, 'COMPLETE');
    assert.equal(r.order?.avgPrice, 1500);
    const fill = r.state.fills[0];
    assert.equal(r.state.account.cash, 1_000_000 - 15000 - fill.charges.total);
    assert.equal(r.state.positions['INFY.NS|CNC'].netQty, 10);

    const next = rolloverTo(r.state, TUE, {}).state;
    assert.deepEqual(Object.keys(next.positions), []);
    assert.equal(next.holdings['INFY.NS'].qty, 10);
    assert.equal(next.holdings['INFY.NS'].avgPrice, 1500);
    assert.equal(next.dayLog[0].day, MON);
    assert.equal(next.dayLog[0].trades, 1);
  });

  it('rejects a delivery sell without holdings', () => {
    const r = place(fresh(), order(INFY, { side: 'SELL' }), at(MON, '10:00'), 1500);
    assert.match(r.error ?? '', /don't hold INFY/);
  });

  it('sells from holdings, books P&L and charges DP once per day', () => {
    let s = place(fresh(), order(INFY, {}), at(MON, '10:00'), 1500).state;
    s = rolloverTo(s, TUE, {}).state;
    const a = place(s, order(INFY, { side: 'SELL', qty: 4 }), at(TUE, '10:00'), 1600);
    assert.equal(a.error, null);
    assert.equal(a.state.fills[0].realizedPnl, 400);
    assert.equal(a.state.fills[0].charges.dp, 15.34);
    const b = place(a.state, order(INFY, { side: 'SELL', qty: 6 }), at(TUE, '10:05'), 1600);
    assert.equal(b.state.fills[0].charges.dp, 0);
    assert.equal(b.state.holdings['INFY.NS'], undefined);
  });

  it('rejects when funds are insufficient', () => {
    const r = place(fresh(), order(INFY, { qty: 1000 }), at(MON, '10:00'), 1500);
    assert.match(r.error ?? '', /Not enough funds/);
  });
});

describe('limit and stop orders', () => {
  it('fills a marketable limit at LTP and a resting limit at its limit price', () => {
    const now = at(MON, '10:00');
    const marketable = place(fresh(), order(INFY, { type: 'LIMIT', price: 1510 }), now, 1500);
    assert.equal(marketable.order?.avgPrice, 1500);

    const resting = place(fresh(), order(INFY, { type: 'LIMIT', price: 1490 }), now, 1500);
    assert.equal(resting.order?.status, 'OPEN');
    assert.ok(resting.order!.blockedAmount > 14900);
    const funds = computeFunds(resting.state, {});
    assert.equal(funds.orderBlocks, resting.order!.blockedAmount);

    const t1 = tick(resting.state, INFY, 1495, at(MON, '10:01'));
    assert.equal(t1.state.orders[0].status, 'OPEN');
    const t2 = tick(t1.state, INFY, 1488, at(MON, '10:02'));
    assert.equal(t2.state.orders[0].status, 'COMPLETE');
    assert.equal(t2.state.orders[0].avgPrice, 1490);
    assert.equal(computeFunds(t2.state, {}).orderBlocks, 0);
  });

  it('triggers an SL-M sell when price falls through the trigger', () => {
    let s = place(fresh(), order(INFY, {}), at(MON, '10:00'), 1500).state;
    const sl = place(s, order(INFY, { side: 'SELL', type: 'SL-M', triggerPrice: 1480 }), at(MON, '10:01'), 1500);
    assert.equal(sl.order?.status, 'TRIGGER_PENDING');
    s = tick(sl.state, INFY, 1485, at(MON, '10:02')).state;
    assert.equal(s.orders[0].status, 'TRIGGER_PENDING');
    const hit = tick(s, INFY, 1478, at(MON, '10:03'));
    assert.equal(hit.state.orders[0].status, 'COMPLETE');
    assert.equal(hit.state.orders[0].avgPrice, 1478);
    assert.ok(hit.events.some((e) => e.kind === 'trigger'));
    assert.equal(hit.state.positions['INFY.NS|CNC'].netQty, 0);
  });

  it('validates stop-loss trigger against LTP', () => {
    const r = place(fresh(), order(INFY, { type: 'SL', triggerPrice: 1490, price: 1495 }), at(MON, '10:00'), 1500);
    assert.match(r.error ?? '', /trigger above the last price/);
  });

  it('SL buy triggers then fills within its limit', () => {
    const r = place(fresh(), order(INFY, { type: 'SL', triggerPrice: 1510, price: 1512 }), at(MON, '10:00'), 1500);
    const t = tick(r.state, INFY, 1511, at(MON, '10:01'));
    assert.equal(t.state.orders[0].status, 'COMPLETE');
    assert.equal(t.state.orders[0].avgPrice, 1511);
  });

  it('modifying a resting limit to a marketable price fills it', () => {
    const r = place(fresh(), order(INFY, { type: 'LIMIT', price: 1400 }), at(MON, '10:00'), 1500);
    const now = at(MON, '10:05');
    const m = modifyOrder(r.state, r.order!.id, { price: 1505 }, { now, quote: quote(INFY, 1500, now), prices: {} });
    assert.equal(m.error, null);
    assert.equal(m.order?.status, 'COMPLETE');
    assert.equal(m.order?.avgPrice, 1500);
  });

  it('expires unfilled day orders at 3:30 PM', () => {
    const r = place(fresh(), order(INFY, { type: 'LIMIT', price: 1400 }), at(MON, '10:00'), 1500);
    const t = tick(r.state, INFY, 1500, at(MON, '15:31'));
    assert.equal(t.state.orders[0].status, 'CANCELLED');
    assert.match(t.state.orders[0].message ?? '', /Expired/);
  });
});

describe('intraday (MIS)', () => {
  it('blocks margin at 5x and releases it on exit', () => {
    const r = place(fresh(), order(SBIN, { product: 'MIS', qty: 100 }), at(MON, '10:00'), 800);
    const pos = r.state.positions['SBIN.NS|MIS'];
    assert.equal(pos.blockedMargin, 16000);
    const funds = computeFunds(r.state, { 'SBIN.NS': 800 });
    assert.equal(funds.available, 1_000_000 - r.state.fills[0].charges.total - 16000);

    const exit = place(r.state, order(SBIN, { product: 'MIS', side: 'SELL', qty: 100 }), at(MON, '11:00'), 810);
    assert.equal(exit.state.positions['SBIN.NS|MIS'].netQty, 0);
    assert.equal(exit.state.positions['SBIN.NS|MIS'].blockedMargin, 0);
    assert.equal(exit.state.fills[0].realizedPnl, 1000);
  });

  it('allows short selling and squares off at 3:20 PM', () => {
    const r = place(fresh(), order(SBIN, { product: 'MIS', side: 'SELL', qty: 50 }), at(MON, '10:00'), 800);
    assert.equal(r.state.positions['SBIN.NS|MIS'].netQty, -50);
    const before = tick(r.state, SBIN, 790, at(MON, '15:19'));
    assert.equal(before.state.positions['SBIN.NS|MIS'].netQty, -50);
    const after = tick(before.state, SBIN, 790, at(MON, '15:20', 5));
    assert.equal(after.state.positions['SBIN.NS|MIS'].netQty, 0);
    assert.equal(after.state.squaredOffDay, MON);
    assert.ok(after.events.some((e) => e.kind === 'squareoff'));
    const sq = after.state.orders.find((o) => o.source === 'SQUARE_OFF');
    assert.equal(sq?.avgPrice, 790);
  });

  it('rejects new intraday orders after square-off time', () => {
    const r = place(fresh(), order(SBIN, { product: 'MIS' }), at(MON, '15:22'), 800);
    assert.match(r.error ?? '', /Intraday \(MIS\) orders close/);
  });
});

describe('after-market orders and holidays', () => {
  it('queues an AMO after close and fills it at the next open', () => {
    const evening = at(MON, '18:00');
    const yesterdayQuote = quote(INFY, 1500, at(MON, '15:29'));
    const r = placeOrder(fresh(), order(INFY, {}), { now: evening, quote: yesterdayQuote, prices: {} });
    assert.equal(r.error, null);
    assert.equal(r.order?.amo, true);
    assert.equal(r.order?.status, 'OPEN');

    // Overnight refreshes must not fill or expire it.
    const night = processQuotes(r.state, { 'INFY.NS': yesterdayQuote }, at(MON, '23:00'));
    assert.equal(night.state.orders[0].status, 'OPEN');

    const open = tick(night.state, INFY, 1520, at(TUE, '09:15', 10));
    assert.equal(open.state.orders[0].status, 'COMPLETE');
    assert.equal(open.state.orders[0].avgPrice, 1520);
    assert.equal(open.state.tradingDay, TUE);
  });

  it('does not execute on a holiday when quotes are from a previous day', () => {
    const r = placeOrder(fresh(), order(INFY, {}), { now: at(MON, '18:00'), quote: quote(INFY, 1500, at(MON, '15:29')), prices: {} });
    const holidayNow = at(TUE, '11:00');
    const stale: Quote = { ...quote(INFY, 1500, at(MON, '15:29')), fetchedAt: holidayNow };
    const t = processQuotes(r.state, { 'INFY.NS': stale }, holidayNow);
    assert.equal(t.state.orders[0].status, 'OPEN');
    const evening = processQuotes(t.state, { 'INFY.NS': stale }, at(TUE, '16:00'));
    assert.equal(evening.state.orders[0].status, 'OPEN', 'AMO survives a holiday');
  });

  it('keeps AMOs over a weekend', () => {
    const fri = '2026-10-30';
    const r = placeOrder(fresh(fri), order(INFY, {}), { now: at(fri, '20:00'), quote: quote(INFY, 1500, at(fri, '15:29')), prices: {} });
    const sat = processQuotes(r.state, { 'INFY.NS': quote(INFY, 1500, at(fri, '15:29')) }, at(SAT, '12:00'));
    assert.equal(sat.state.orders[0].status, 'OPEN');
  });
});

describe('catch-up replay', () => {
  const candle = (day: string, hhmm: string, o: number, h: number, l: number, c: number): Candle => ({
    t: at(day, hhmm),
    o,
    h,
    l,
    c,
    v: 1000,
  });

  it('fills a resting limit from candles while the app was closed', () => {
    const r = place(fresh(), order(INFY, { type: 'LIMIT', price: 1490 }), at(MON, '10:00', 20), 1500);
    const series = {
      'INFY.NS': [
        candle(MON, '10:00', 1500, 1502, 1495, 1497), // placement minute, ignored
        candle(MON, '10:01', 1497, 1499, 1492, 1493),
        candle(MON, '10:02', 1493, 1494, 1487, 1489),
        candle(MON, '10:03', 1489, 1491, 1485, 1490),
      ],
    };
    const out = replayCandles(r.state, series, at(MON, '10:00', 30), at(MON, '10:10'), {});
    const o = out.state.orders[0];
    assert.equal(o.status, 'COMPLETE');
    assert.equal(o.avgPrice, 1490);
    assert.equal(o.filledAt, at(MON, '10:02', 30));
  });

  it('squares off intraday positions at the 3:20 PM price when the app was closed', () => {
    const r = place(fresh(), order(SBIN, { product: 'MIS', qty: 10 }), at(MON, '10:00'), 800);
    const series = {
      'SBIN.NS': [candle(MON, '15:18', 805, 806, 804, 805), candle(MON, '15:19', 805, 807, 805, 806), candle(MON, '15:20', 806, 809, 806, 808)],
    };
    const out = replayCandles(r.state, series, at(MON, '10:01'), at(MON, '17:00'), {});
    assert.equal(out.state.positions['SBIN.NS|MIS'].netQty, 0);
    const sq = out.state.orders.find((o) => o.source === 'SQUARE_OFF');
    assert.equal(sq?.avgPrice, 806);
    assert.equal(out.state.squaredOffDay, MON);
  });

  it('rolls over across days and fills an AMO at the next open from candles', () => {
    const r = placeOrder(fresh(), order(INFY, {}), { now: at(MON, '18:00'), quote: quote(INFY, 1500, at(MON, '15:29')), prices: {} });
    const series = { 'INFY.NS': [candle(TUE, '09:15', 1510, 1515, 1505, 1512), candle(TUE, '09:16', 1512, 1513, 1508, 1509)] };
    const out = replayCandles(r.state, series, at(MON, '18:00'), at(TUE, '09:30'), {});
    assert.equal(out.state.tradingDay, TUE);
    assert.equal(out.state.orders[0].status, 'COMPLETE');
    assert.equal(out.state.orders[0].avgPrice, 1510);
  });
});

describe('account summary', () => {
  it('equity tracks cash plus marked positions', () => {
    let s = place(fresh(), order(INFY, {}), at(MON, '10:00'), 1500).state;
    s = place(s, order(SBIN, { product: 'MIS', qty: 100 }), at(MON, '10:01'), 800).state;
    const q = { 'INFY.NS': quote(INFY, 1550, at(MON, '11:00'), 1490), 'SBIN.NS': quote(SBIN, 790, at(MON, '11:00'), 800) };
    const sum = accountSummary(s, q);
    const charges = s.account.chargesPaid;
    assert.equal(sum.equity, Math.round((1_000_000 - charges + 500 - 1000) * 100) / 100);
    assert.equal(sum.netPnl, Math.round((500 - 1000 - charges) * 100) / 100);
  });
});

describe('google fallback parser', () => {
  it('reads the last price, timestamp and previous close', () => {
    const html =
      '<div jsname="ip75Cb" data-last-price="1224.7" data-last-normal-market-timestamp="1761471000" data-currency-code="INR"><div class="YMlKec fxKbKc">₹1,224.70</div></div>' +
      '<div class="mfs7Fc">Previous close</div><div class="P6K39c">₹1,220.30</div>' +
      '<div class="mfs7Fc">Day range</div><div class="P6K39c">₹1,210.50 - ₹1,227.40</div>';
    const q = parseGoogleQuote(html, 'RELIANCE.NS', 0);
    assert.equal(q.ltp, 1224.7);
    assert.equal(q.prevClose, 1220.3);
    assert.equal(q.low, 1210.5);
    assert.equal(q.high, 1227.4);
    assert.equal(q.time, 1761471000000);
  });
});

describe('yahoo parsing', () => {
  const chartResult = (symbol: string, price: number) => ({
    meta: {
      symbol,
      regularMarketPrice: price,
      previousClose: price - 10,
      regularMarketTime: 1761471000,
      regularMarketDayHigh: price + 5,
      regularMarketDayLow: price - 15,
      regularMarketVolume: 12345,
      fiftyTwoWeekHigh: price * 1.2,
      fiftyTwoWeekLow: price * 0.8,
      longName: `${symbol} Ltd`,
    },
    timestamp: [1761450300],
    indicators: { quote: [{ open: [price - 8], high: [price + 5], low: [price - 15], close: [price], volume: [12345] }] },
  });

  it('parses a chart result into a quote', async () => {
    const { parseChartQuote } = await import('../src/data/yahoo');
    const q = parseChartQuote('INFY.NS', chartResult('INFY.NS', 1500));
    assert.equal(q.ltp, 1500);
    assert.equal(q.prevClose, 1490);
    assert.equal(q.open, 1492);
    assert.equal(q.time, 1761471000000);
    assert.equal(q.name, 'INFY.NS Ltd');
  });

  it('batches symbols through spark and reports the ones it missed', async () => {
    const { yahooQuotesBatch } = await import('../src/data/yahoo');
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (url: string) => {
      calls++;
      assert.match(String(url), /\/v7\/finance\/spark\?symbols=INFY\.NS,M%26M\.NS,TCS\.NS/);
      const body = { spark: { result: [{ symbol: 'INFY.NS', response: [chartResult('INFY.NS', 1500)] }, { symbol: 'M&M.NS', response: [chartResult('M&M.NS', 3100)] }, { symbol: 'TCS.NS', response: null }] } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const out = await yahooQuotesBatch(['INFY.NS', 'M&M.NS', 'TCS.NS']);
      assert.equal(calls, 1);
      assert.deepEqual(out.quotes.map((q) => q.symbol), ['INFY.NS', 'M&M.NS']);
      assert.deepEqual(out.missing, ['TCS.NS']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
