/**
 * Market data feed with automatic failover:
 * Yahoo Finance (query1 → query2) first, Google Finance for NSE symbols when Yahoo
 * keeps failing. Yahoo is retried after a cool-down.
 */
import type { Instrument, Quote } from '../engine/types';
import { canUseGoogle, googleQuote } from './google';
import { FeedError, mapLimit } from './http';
import { yahooQuote, yahooQuotesBatch } from './yahoo';

const COOLDOWN_MS = 2 * 60_000;
const FAILS_BEFORE_COOLDOWN = 3;

const health = {
  yahooFailStreak: 0,
  yahooCooldownUntil: 0,
};

export function isYahooCoolingDown(now = Date.now()): boolean {
  return now < health.yahooCooldownUntil;
}

function noteYahoo(ok: boolean) {
  if (ok) {
    health.yahooFailStreak = 0;
    health.yahooCooldownUntil = 0;
    return;
  }
  health.yahooFailStreak++;
  if (health.yahooFailStreak >= FAILS_BEFORE_COOLDOWN) health.yahooCooldownUntil = Date.now() + COOLDOWN_MS;
}

export async function fetchQuote(inst: Instrument): Promise<Quote> {
  const googleOk = canUseGoogle(inst);
  const preferGoogle = googleOk && isYahooCoolingDown();
  let lastError: unknown = null;

  if (!preferGoogle) {
    try {
      const q = await yahooQuote(inst.symbol);
      noteYahoo(true);
      return q;
    } catch (e) {
      lastError = e;
      // A clear "symbol not found" is the symbol's fault, not the feed's.
      if (e instanceof FeedError && !e.retryable) throw e;
      noteYahoo(false);
    }
  }
  if (googleOk) {
    try {
      return await googleQuote(inst);
    } catch (e) {
      lastError = e;
    }
  }
  if (preferGoogle) {
    try {
      const q = await yahooQuote(inst.symbol);
      noteYahoo(true);
      return q;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new FeedError('Price unavailable', 0, true);
}

export interface BatchResult {
  quotes: Quote[];
  errors: { symbol: string; message: string }[];
}

/** The one-request batch endpoint is skipped for a while after it fails or answers nothing. */
const BATCH_RETRY_MS = 10 * 60_000;
let batchDisabledUntil = 0;

export function isBatchAvailable(now = Date.now()): boolean {
  return now >= batchDisabledUntil && !isYahooCoolingDown(now);
}

/** Symbols that have returned a price before. Only these go into batches, so one bad symbol can't fail a batch. */
const knownGood = new Set<string>();

export async function fetchQuotes(instruments: Instrument[], concurrency = 4): Promise<BatchResult> {
  const quotes: Quote[] = [];
  let rest = instruments;
  const batchable = instruments.filter((i) => knownGood.has(i.symbol));

  if (batchable.length > 1 && isBatchAvailable()) {
    try {
      const batch = await yahooQuotesBatch(batchable.map((i) => i.symbol));
      if (batch.quotes.length === 0) {
        batchDisabledUntil = Date.now() + BATCH_RETRY_MS;
      } else {
        noteYahoo(true);
        quotes.push(...batch.quotes);
        for (const q of batch.quotes) knownGood.add(q.symbol);
        const got = new Set(batch.quotes.map((q) => q.symbol));
        rest = instruments.filter((i) => !got.has(i.symbol));
      }
    } catch {
      batchDisabledUntil = Date.now() + BATCH_RETRY_MS;
    }
  }

  const settled = await mapLimit(rest, concurrency, fetchQuote);
  const errors: BatchResult['errors'] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      quotes.push(r.value);
      if (r.value.source === 'yahoo') knownGood.add(r.value.symbol);
    }
    else errors.push({ symbol: rest[i].symbol, message: r.reason instanceof Error ? r.reason.message : 'Price unavailable' });
  });
  return { quotes, errors };
}
