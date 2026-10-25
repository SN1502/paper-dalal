/** Number formatting in the Indian system (lakh / crore grouping). */

const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/** 1234567.8 -> "12,34,567.80" */
export function num(x: number | null | undefined, digits: 0 | 2 = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return digits === 0 ? inr0.format(x) : inr2.format(x);
}

/** 1234567.8 -> "₹12,34,567.80" (minus sign before the rupee symbol). */
export function rupees(x: number | null | undefined, digits: 0 | 2 = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  const s = num(Math.abs(x), digits);
  return x < 0 ? `-₹${s}` : `₹${s}`;
}

/** Same as rupees() but always signed: "+₹1,200.00" / "-₹40.00". */
export function signedRupees(x: number | null | undefined, digits: 0 | 2 = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  if (Math.abs(x) < 0.005) return `₹${num(0, digits)}`;
  return x > 0 ? `+₹${num(x, digits)}` : `-₹${num(-x, digits)}`;
}

export function signedNum(x: number | null | undefined, digits: 0 | 2 = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  if (Math.abs(x) < 0.005) return num(0, digits);
  return x > 0 ? `+${num(x, digits)}` : `-${num(-x, digits)}`;
}

export function pct(x: number | null | undefined, signed = true): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  const v = Math.abs(x) < 0.005 ? 0 : x;
  const s = `${Math.abs(v).toFixed(2)}%`;
  if (!signed) return v < 0 ? `-${s}` : s;
  return v > 0 ? `+${s}` : v < 0 ? `-${s}` : s;
}

/** Compact Indian notation: ₹12.4 L, ₹3.21 Cr, ₹950. */
export function compactRupees(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  const sign = x < 0 ? '-' : '';
  const a = Math.abs(x);
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `${sign}₹${num(a, 0)}`;
  return `${sign}₹${num(a, 2)}`;
}

/** Volume: 12.4L, 3.2Cr, 9,800 */
export function compactCount(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  if (x >= 1e7) return `${(x / 1e7).toFixed(2)} Cr`;
  if (x >= 1e5) return `${(x / 1e5).toFixed(2)} L`;
  return num(x, 0);
}

/** Parse a user-typed amount like "1,23,456.5" -> 123456.5 (NaN if invalid). */
export function parseAmount(text: string): number {
  const cleaned = text.replace(/[₹,\s]/g, '');
  if (cleaned === '' || !/^\d*\.?\d*$/.test(cleaned)) return NaN;
  return Number(cleaned);
}

export function newId(prefix = ''): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
}
