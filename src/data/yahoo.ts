/**
 * Yahoo Finance public chart and search endpoints. No API key is needed; NSE symbols
 * end in ".NS", BSE in ".BO", and indices start with "^".
 */
import type { Candle, Quote } from '../engine/types';
import { FeedError, fetchWithTimeout } from './http';

const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

const HEADERS: Record<string, string> = {
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'en-IN,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
};

async function getJson(path: string, timeoutMs: number): Promise<any> {
  let lastError: unknown = null;
  for (const host of HOSTS) {
    try {
      const res = await fetchWithTimeout(`${host}${path}`, { headers: HEADERS }, timeoutMs);
      if (res.status === 404) {
        const body = await res.json().catch(() => null);
        const desc = body?.chart?.error?.description;
        throw new FeedError(desc || 'Symbol not found', 404, false);
      }
      if (!res.ok) throw new FeedError(`Yahoo returned ${res.status}`, res.status, true);
      return await res.json();
    } catch (e) {
      lastError = e;
      if (e instanceof FeedError && !e.retryable) throw e;
    }
  }
  throw lastError instanceof Error ? lastError : new FeedError('Yahoo Finance is unreachable', 0, true);
}

const lastValid = (arr: (number | null)[] | undefined): number | null => {
  if (!arr) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
};

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function yahooQuote(symbol: string): Promise<Quote> {
  const json = await getJson(
    `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d&includePrePost=false`,
    8000,
  );
  const result = json?.chart?.result?.[0];
  if (!result) throw new FeedError(json?.chart?.error?.description || 'No data for this symbol', 404, false);
  return parseChartQuote(symbol, result);
}

const BATCH_SIZE = 20;

/**
 * Many symbols in one request through the spark endpoint, which returns the same
 * per-symbol chart payload. Symbols it doesn't answer come back in `missing`.
 */
export async function yahooQuotesBatch(symbols: string[]): Promise<{ quotes: Quote[]; missing: string[] }> {
  const quotes: Quote[] = [];
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const chunk = symbols.slice(i, i + BATCH_SIZE);
    const json = await getJson(
      `/v7/finance/spark?symbols=${chunk.map(encodeURIComponent).join(',')}&range=1d&interval=1d&includePrePost=false`,
      10000,
    );
    const results: any[] = json?.spark?.result ?? [];
    for (const r of results) {
      const res = r?.response?.[0];
      const sym = typeof r?.symbol === 'string' ? r.symbol : res?.meta?.symbol;
      if (!res || !sym || !chunk.includes(sym)) continue;
      try {
        quotes.push(parseChartQuote(sym, res));
      } catch {
        // Left in `missing`; fetched individually.
      }
    }
  }
  const got = new Set(quotes.map((q) => q.symbol));
  return { quotes, missing: symbols.filter((s) => !got.has(s)) };
}

export function parseChartQuote(symbol: string, result: any): Quote {
  const m = result?.meta ?? {};
  const ltp = numOrNull(m.regularMarketPrice);
  if (ltp === null || ltp <= 0) throw new FeedError('No price in response', 0, true);
  const q = result.indicators?.quote?.[0] ?? {};
  return {
    symbol,
    ltp,
    prevClose: numOrNull(m.previousClose) ?? numOrNull(m.chartPreviousClose),
    open: lastValid(q.open),
    high: numOrNull(m.regularMarketDayHigh) ?? lastValid(q.high),
    low: numOrNull(m.regularMarketDayLow) ?? lastValid(q.low),
    volume: numOrNull(m.regularMarketVolume) ?? lastValid(q.volume),
    week52High: numOrNull(m.fiftyTwoWeekHigh),
    week52Low: numOrNull(m.fiftyTwoWeekLow),
    time: (numOrNull(m.regularMarketTime) ?? 0) * 1000,
    fetchedAt: Date.now(),
    source: 'yahoo',
    name: (m.longName as string) || (m.shortName as string) || null,
  };
}

export type ChartRange = '1d' | '5d' | '1mo' | '6mo' | '1y' | '5y';

export const RANGE_INTERVAL: Record<ChartRange, string> = {
  '1d': '1m',
  '5d': '15m',
  '1mo': '60m',
  '6mo': '1d',
  '1y': '1d',
  '5y': '1wk',
};

export interface CandleSeries {
  candles: Candle[];
  prevClose: number | null;
  /** Regular session bounds for the latest day (epoch ms), when Yahoo provides them. */
  sessionStart: number | null;
  sessionEnd: number | null;
}

export async function yahooCandles(symbol: string, range: ChartRange, interval = RANGE_INTERVAL[range]): Promise<CandleSeries> {
  const json = await getJson(
    `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`,
    12000,
  );
  const result = json?.chart?.result?.[0];
  if (!result) throw new FeedError(json?.chart?.error?.description || 'No chart data', 404, false);
  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const candles: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    if (typeof c !== 'number' || !Number.isFinite(c)) continue;
    const o = numOrNull(q.open?.[i]) ?? c;
    const h = numOrNull(q.high?.[i]) ?? Math.max(o, c);
    const l = numOrNull(q.low?.[i]) ?? Math.min(o, c);
    candles.push({ t: ts[i] * 1000, o, h, l, c, v: numOrNull(q.volume?.[i]) ?? 0 });
  }
  const m = result.meta ?? {};
  const regular = m.currentTradingPeriod?.regular;
  return {
    candles,
    prevClose: range === '1d' ? numOrNull(m.previousClose) ?? numOrNull(m.chartPreviousClose) : numOrNull(m.chartPreviousClose),
    sessionStart: numOrNull(regular?.start) !== null ? regular.start * 1000 : null,
    sessionEnd: numOrNull(regular?.end) !== null ? regular.end * 1000 : null,
  };
}

export interface SearchHit {
  symbol: string;
  name: string;
  exchange: 'NSE' | 'BSE';
  type: string;
}

export async function yahooSearch(query: string): Promise<SearchHit[]> {
  const json = await getJson(
    `/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=20&newsCount=0&listsCount=0&enableFuzzyQuery=false`,
    8000,
  );
  const quotes: any[] = json?.quotes ?? [];
  const hits: SearchHit[] = [];
  for (const q of quotes) {
    const symbol: string | undefined = q?.symbol;
    if (!symbol) continue;
    const isNse = symbol.endsWith('.NS');
    const isBse = symbol.endsWith('.BO');
    if (!isNse && !isBse) continue;
    const type = String(q.quoteType ?? '');
    if (type && type !== 'EQUITY' && type !== 'ETF') continue;
    hits.push({
      symbol,
      name: q.longname || q.shortname || symbol,
      exchange: isNse ? 'NSE' : 'BSE',
      type: type || 'EQUITY',
    });
  }
  return hits;
}
