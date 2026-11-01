/**
 * §3.2 earnings momentum and §3.3 value from "151 Trading Strategies".
 * Claude reads the raw numbers (e.g. from screener.in) and this code does the arithmetic.
 */
import { mean, round, stdev } from './math';

export interface FundamentalInput {
  /** Quarterly EPS, oldest first. At least 8 quarters; 12 gives the paper's full window. */
  quarterlyEps: number[];
  bookValuePerShare: number | null;
  price: number;
}

export interface FundamentalScore {
  /** Eq. (274): SUE = (E − E′)/σ, E′ = EPS four quarters earlier, σ over the last 8 quarters. */
  sue: number | null;
  latestUnexpected: number | null;
  unexpectedQuarters: number;
  sueLabel: 'strong positive' | 'positive' | 'neutral' | 'negative' | 'strong negative' | 'unavailable';
  /** Book-to-price (the paper's value factor). */
  bookToPrice: number | null;
  /** Trailing-four-quarter earnings yield. */
  earningsYield: number | null;
  trailingEps: number | null;
  notes: string[];
}

export function scoreFundamentals(input: FundamentalInput): FundamentalScore {
  const eps = input.quarterlyEps.filter((x) => Number.isFinite(x));
  const notes: string[] = [];
  const ue: number[] = [];
  for (let i = 4; i < eps.length; i++) ue.push(eps[i] - eps[i - 4]);
  const window = ue.slice(-8);

  let sue: number | null = null;
  if (window.length >= 4) {
    const s = stdev(window);
    if (s > 0) sue = window[window.length - 1] / s;
    else notes.push('Unexpected earnings did not vary, so SUE is undefined.');
    if (window.length < 8) notes.push(`SUE uses ${window.length} quarters of unexpected earnings; the paper uses 8 (needs 12 quarters of EPS).`);
  } else {
    notes.push('Need at least 8 quarters of EPS to compute SUE.');
  }

  const trailing = eps.length >= 4 ? eps.slice(-4).reduce((a, b) => a + b, 0) : null;
  const bp = input.bookValuePerShare !== null && input.bookValuePerShare > 0 && input.price > 0 ? input.bookValuePerShare / input.price : null;
  if (input.bookValuePerShare !== null && input.bookValuePerShare <= 0) notes.push('Book value is zero or negative.');

  let label: FundamentalScore['sueLabel'] = 'unavailable';
  if (sue !== null) {
    label = sue >= 1.5 ? 'strong positive' : sue >= 0.5 ? 'positive' : sue > -0.5 ? 'neutral' : sue > -1.5 ? 'negative' : 'strong negative';
  }
  if (window.length >= 2 && mean(window) < 0 && (sue ?? 0) > 0) notes.push('Latest quarter improved, but the average year-on-year change is still negative.');

  return {
    sue: sue !== null ? round(sue, 2) : null,
    latestUnexpected: window.length ? round(window[window.length - 1], 2) : null,
    unexpectedQuarters: window.length,
    sueLabel: label,
    bookToPrice: bp !== null ? round(bp, 4) : null,
    earningsYield: trailing !== null && input.price > 0 ? round(trailing / input.price, 4) : null,
    trailingEps: trailing !== null ? round(trailing, 2) : null,
    notes,
  };
}
