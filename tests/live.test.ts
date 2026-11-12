import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STRATEGY_UNIVERSE } from '../src/data/instruments';
import { istTimestamp, parseHHMM } from '../src/lib/time';
import { aggregate, applyTick, emptyIntraday, mergeCandles, openingRange, vwap, type IntradayState } from '../src/live/bars';
import { buildMatchers, companyIndex, isMacroHeadline, isRoutineFiling, matchSymbols, normalizeCompany } from '../src/live/match';
import { checkStopTighten, DEFAULT_LIVE_SETTINGS, sizeIntraday, type IntradayCheck } from '../src/live/risk';
import { decodeEntities, parseFeedDate, parseRss } from '../src/live/rss';
import { detectSignals, intradaySummary, pivotLevels } from '../src/live/signals';

const DAY = '2026-11-12';
const at = (hhmm: string, sec = 0) => istTimestamp(DAY, parseHHMM(hhmm)) + sec * 1000;

describe('RSS parsing', () => {
  it('reads a Pulse-style RSS 2.0 feed with double-escaped entities', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Pulse</title>
      <item><title>Tata Power Q2 profit jumps 32% to ₹1,652 crore &amp;amp; more</title>
      <description><![CDATA[<p>Thermal and hydro <b>operations</b> led growth.</p>]]></description>
      <link>https://example.com/a</link><guid>https://example.com/a</guid>
      <pubDate>Wed, 11 Nov 2026 21:55:39 +0530</pubDate></item>
      <item><title>Second</title><link>https://example.com/b</link><pubDate>Thu, 12 Nov 2026 06:51:48 +0530</pubDate></item>
    </channel></rss>`;
    const items = parseRss(xml);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, 'Tata Power Q2 profit jumps 32% to ₹1,652 crore & more');
    assert.equal(items[0].description, 'Thermal and hydro operations led growth.');
    assert.equal(items[0].publishedAt, Date.UTC(2026, 10, 11, 16, 25, 39));
    assert.equal(items[1].link, 'https://example.com/b');
  });

  it("parses NSE's date format as IST and ISO dates", () => {
    assert.equal(parseFeedDate('12-Nov-2026 13:57:40'), Date.UTC(2026, 10, 12, 8, 27, 40));
    assert.equal(parseFeedDate('2026-11-12T08:00:00Z'), Date.UTC(2026, 10, 12, 8, 0, 0));
    assert.equal(parseFeedDate('not a date'), null);
    assert.equal(decodeEntities('A &amp;amp; B &#8377;'), 'A & B ₹');
  });
});

describe('matching news to stocks', () => {
  const matchers = buildMatchers(STRATEGY_UNIVERSE);
  it('finds companies by name and common short names', () => {
    assert.deepEqual(matchSymbols('Tata Power Q2 profit jumps 32%', matchers), ['TATAPOWER.NS']);
    assert.deepEqual(matchSymbols('L&T bags mega order from Middle East', matchers), ['LT.NS']);
    assert.deepEqual(matchSymbols('Zomato parent Eternal shares surge', matchers), ['ETERNAL.NS']);
    assert.ok(matchSymbols('HDFC Bank, ICICI Bank lead gains', matchers).includes('ICICIBANK.NS'));
    assert.deepEqual(matchSymbols('Persistent inflation worries traders', matchers), []);
    assert.deepEqual(matchSymbols('titan of industry', matchers), []);
  });

  it('matches NSE filings by legal name and spots routine filings and macro news', () => {
    const idx = companyIndex(STRATEGY_UNIVERSE);
    assert.equal(normalizeCompany('Info Edge (India) Limited'), 'info edge');
    assert.equal(idx.get(normalizeCompany('Reliance Industries Limited')), 'RELIANCE.NS');
    assert.equal(idx.get(normalizeCompany('Larsen & Toubro Limited')), 'LT.NS');
    assert.equal(isRoutineFiling('Closure of Trading Window'), true);
    assert.equal(isRoutineFiling('Outcome of Board Meeting'), false);
    assert.equal(isMacroHeadline('RBI keeps repo rate unchanged'), true);
    assert.equal(isMacroHeadline('Infosys wins a deal'), false);
  });
});

function bar(t: number, o: number, h: number, l: number, c: number, v = 1000) {
  return { t, o, h, l, c, v };
}

describe('intraday bars', () => {
  it('builds minute bars from ticks with volume deltas and merges 1-minute candles', () => {
    let s = emptyIntraday(DAY);
    s = applyTick(s, 100, 10_000, at('09:15', 5));
    s = applyTick(s, 101, 10_600, at('09:15', 30));
    s = applyTick(s, 99.5, 11_000, at('09:16', 2));
    assert.equal(s.bars.length, 2);
    assert.deepEqual([s.bars[0].o, s.bars[0].h, s.bars[0].l, s.bars[0].c, s.bars[0].v], [100, 101, 100, 101, 600]);
    assert.equal(s.bars[1].v, 400);
    s = mergeCandles(s, [{ t: at('09:15'), o: 100, h: 101.5, l: 99.8, c: 101, v: 5000 }]);
    assert.equal(s.bars[0].h, 101.5);
    assert.equal(s.bars[0].v, 5000);
    assert.equal(applyTick(s, 102, null, at('16:00')).bars.length, 2, 'ignores ticks outside the session');
  });

  it('aggregates to 5 minutes and computes VWAP and the opening range', () => {
    const bars = Array.from({ length: 20 }, (_, i) => bar(at('09:15') + i * 60_000, 100 + i, 101 + i, 99 + i, 100.5 + i, 100));
    const five = aggregate(bars, 5);
    assert.equal(five.length, 4);
    assert.equal(five[0].h, 105);
    assert.equal(five[0].v, 500);
    const or = openingRange(bars, 15)!;
    assert.equal(or.high, 115);
    assert.equal(or.complete, true);
    assert.ok(Math.abs((vwap(bars) as number) - 109.6667) < 0.01, `vwap ${vwap(bars)}`);
  });
});

function stateFrom(closes: number[], start = at('09:15'), vol = (i: number) => 1000): IntradayState {
  return {
    day: DAY,
    lastCumVolume: null,
    bars: closes.map((c, i) => bar(start + i * 60_000, i ? closes[i - 1] : c, Math.max(c, i ? closes[i - 1] : c), Math.min(c, i ? closes[i - 1] : c), c, vol(i))),
  };
}

describe('intraday signals', () => {
  const ctx = { prevHigh: 105, prevLow: 95, prevClose: 100 };

  it('fires an opening-range breakout once the range is complete', () => {
    const closes = [...Array(15).fill(0).map((_, i) => 100 + (i % 3) * 0.2), ...Array(5).fill(100.3), 100.9];
    const s = stateFrom(closes);
    const sig = detectSignals('X.NS', s, ctx, at('09:35'));
    assert.ok(sig.some((x) => x.kind === 'orb_breakout' && x.direction === 'long'), JSON.stringify(sig.map((x) => x.kind)));
  });

  it('fires a §3.14 pivot break and reports pivot levels', () => {
    const pv = pivotLevels(ctx);
    assert.equal(pv.pivot, 100);
    assert.equal(pv.resistance, 105);
    assert.equal(pv.support, 95);
    const s = stateFrom([...Array(30).fill(104.5), 105.3]);
    const sig = detectSignals('X.NS', s, ctx, at('09:46'));
    assert.ok(sig.some((x) => x.kind === 'pivot_resistance_break' && x.paper === '§3.14'));
  });

  it('flags a volume spike and a sharp move', () => {
    const closes = [...Array(30).fill(100), 100.6, 101.7];
    const s = stateFrom(closes, at('10:00'), (i) => (i === 30 ? 6000 : 1000));
    const sig = detectSignals('X.NS', s, ctx, at('10:32'));
    assert.ok(sig.some((x) => x.kind === 'volume_spike' && x.direction === 'long'));
    assert.ok(sig.some((x) => x.kind === 'sharp_move_up'));
  });

  it('flags an opening gap only in the first minutes', () => {
    const s = stateFrom([103]);
    s.bars[0].o = 103;
    assert.ok(detectSignals('X.NS', s, ctx, at('09:16')).some((x) => x.kind === 'gap_up'));
    assert.ok(!detectSignals('X.NS', s, ctx, at('09:40')).some((x) => x.kind === 'gap_up'));
  });

  it('summarises a stock for the AI', () => {
    const s = stateFrom(Array.from({ length: 60 }, (_, i) => 100 + i * 0.05));
    const sum = intradaySummary(s, ctx, 103)!;
    assert.equal(sum.ltp, 103);
    assert.equal(sum.pivots_from_previous_day?.resistance, 105);
    assert.ok(sum.last_5min_bars.length > 0);
    assert.ok(sum.vwap !== null);
  });
});

describe('intraday risk limits', () => {
  const base: IntradayCheck = {
    direction: 'long',
    equity: 1_000_000,
    available: 900_000,
    leverage: 5,
    entry: 1000,
    stop: 990,
    target: 1020,
    liquidityCr: 200,
    openPositions: 0,
    tradesToday: 0,
    pnlToday: 0,
    alreadyInSymbol: false,
    minutesNow: 11 * 60,
    isIndex: false,
    exchange: 'NSE',
    settings: DEFAULT_LIVE_SETTINGS,
  };

  it('sizes by risk and caps by position value', () => {
    const r = sizeIntraday(base);
    assert.equal(r.ok && r.qty, 200, '0.5% risk = ₹5,000 / ₹10, capped at 20% = 200 shares');
    const wide = sizeIntraday({ ...base, stop: 980, target: 1040 });
    assert.equal(wide.ok && wide.qty, 200);
    const tight = sizeIntraday({ ...base, entry: 1000, stop: 995, target: 1010, settings: { ...DEFAULT_LIVE_SETTINGS, maxNotionalPct: 100 } });
    assert.equal(tight.ok && tight.qty, 1000);
  });

  it('handles shorts and enforces the daily limits', () => {
    assert.equal(sizeIntraday({ ...base, direction: 'short', stop: 1010, target: 980 }).ok, true);
    assert.equal(sizeIntraday({ ...base, direction: 'short', stop: 990, target: 980 }).ok, false);
    assert.equal(sizeIntraday({ ...base, direction: 'short', stop: 1010, target: 980, settings: { ...DEFAULT_LIVE_SETTINGS, allowShort: false } }).ok, false);
    assert.equal(sizeIntraday({ ...base, pnlToday: -20_000 }).ok, false, 'daily loss limit');
    assert.equal(sizeIntraday({ ...base, tradesToday: 6 }).ok, false);
    assert.equal(sizeIntraday({ ...base, openPositions: 3 }).ok, false);
    assert.equal(sizeIntraday({ ...base, minutesNow: 14 * 60 + 50 }).ok, false, 'after last entry time');
    assert.equal(sizeIntraday({ ...base, stop: 999 }).ok, false, 'stop too tight');
    assert.equal(sizeIntraday({ ...base, stop: 960, target: 1100 }).ok, false, 'stop too wide');
    assert.equal(sizeIntraday({ ...base, liquidityCr: 5 }).ok, false);
  });

  it('only lets stops tighten', () => {
    assert.equal(checkStopTighten('long', 990, 995, 1005), null);
    assert.match(checkStopTighten('long', 990, 985, 1005) ?? '', /tightened/);
    assert.equal(checkStopTighten('short', 1010, 1005, 995), null);
    assert.match(checkStopTighten('short', 1010, 1015, 995) ?? '', /tightened/);
    assert.match(checkStopTighten('short', 1010, 990, 995) ?? '', /above the current price/);
  });
});
