/**
 * Fallback quote source: the public Google Finance quote page.
 * Used only when Yahoo Finance fails. It gives the last price, its timestamp and
 * the previous close; it has no candle history.
 */
import type { Instrument, Quote } from '../engine/types';
import { googleTicker } from './instruments';
import { FeedError, fetchWithTimeout } from './http';

const HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-IN,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
};

function parseNumber(text: string | undefined | null): number | null {
  if (!text) return null;
  const m = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Finds the value printed after a stats label such as "Previous close". */
function statAfter(html: string, label: string): string | null {
  const idx = html.indexOf(label);
  if (idx < 0) return null;
  const slice = html.slice(idx, idx + 1500);
  const m = slice.match(/class="P6K39c"[^>]*>([^<]+)</);
  return m ? m[1] : null;
}

export function parseGoogleQuote(html: string, symbol: string, now = Date.now()): Quote {
  const price = html.match(/data-last-price="([0-9.]+)"/);
  if (!price) throw new FeedError('Google Finance page had no price', 0, true);
  const ts = html.match(/data-last-normal-market-timestamp="(\d+)"/);
  const range = statAfter(html, 'Day range');
  const year = statAfter(html, 'Year range');
  const [low, high] = range ? range.split('-').map(parseNumber) : [null, null];
  const [w52l, w52h] = year ? year.split('-').map(parseNumber) : [null, null];
  return {
    symbol,
    ltp: Number(price[1]),
    prevClose: parseNumber(statAfter(html, 'Previous close')),
    open: null,
    high: high ?? null,
    low: low ?? null,
    volume: null,
    week52High: w52h ?? null,
    week52Low: w52l ?? null,
    time: ts ? Number(ts[1]) * 1000 : 0,
    fetchedAt: now,
    source: 'google',
    name: null,
  };
}

export function canUseGoogle(inst: Instrument): boolean {
  return googleTicker(inst) !== null;
}

export async function googleQuote(inst: Instrument): Promise<Quote> {
  const ticker = googleTicker(inst);
  if (!ticker) throw new FeedError('No fallback source for this symbol', 0, false);
  const res = await fetchWithTimeout(`https://www.google.com/finance/quote/${ticker}?hl=en`, { headers: HEADERS }, 10000);
  if (!res.ok) throw new FeedError(`Google Finance returned ${res.status}`, res.status, true);
  const html = await res.text();
  return parseGoogleQuote(html, inst.symbol);
}
