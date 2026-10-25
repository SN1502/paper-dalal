/**
 * Indian market clock helpers. Everything here works in IST (UTC+05:30),
 * independent of the phone's own time zone.
 */

export const IST_OFFSET_MS = 330 * 60_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Session boundaries for NSE/BSE cash equity, in minutes after IST midnight. */
export const SESSION = {
  preOpen: 9 * 60, // 09:00
  open: 9 * 60 + 15, // 09:15
  close: 15 * 60 + 30, // 15:30
} as const;

export interface IstParts {
  year: number;
  month: number; // 1-12
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
  weekday: number; // 0 = Sunday
  minuteOfDay: number;
}

export function istParts(ms: number): IstParts {
  const d = new Date(ms + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    seconds: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
    minuteOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/** IST calendar date as YYYY-MM-DD. String comparison orders dates correctly. */
export function istDayKey(ms: number): string {
  const p = istParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Epoch ms for a given IST day at `minuteOfDay` minutes after midnight. */
export function istTimestamp(dayKey: string, minuteOfDay: number): number {
  const [y, m, d] = dayKey.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 0, 0, 0) - IST_OFFSET_MS + minuteOfDay * MINUTE;
}

export function minuteFloor(ms: number): number {
  return Math.floor(ms / MINUTE) * MINUTE;
}

export function addDays(dayKey: string, days: number): string {
  return istDayKey(istTimestamp(dayKey, 12 * 60) + days * DAY);
}

export function isWeekday(ms: number): boolean {
  const w = istParts(ms).weekday;
  return w >= 1 && w <= 5;
}

/** "15:20" -> 920 */
export function parseHHMM(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

export function formatHHMM(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${suffix}`;
}

/** Phase of the trading day judged by the clock alone (holidays are detected from the feed). */
export type ClockPhase = 'weekend' | 'pre-market' | 'pre-open' | 'open' | 'post-market';

export function clockPhase(ms: number): ClockPhase {
  if (!isWeekday(ms)) return 'weekend';
  const m = istParts(ms).minuteOfDay;
  if (m < SESSION.preOpen) return 'pre-market';
  if (m < SESSION.open) return 'pre-open';
  if (m < SESSION.close) return 'open';
  return 'post-market';
}

export function isWithinSessionClock(ms: number): boolean {
  return clockPhase(ms) === 'open';
}

export function formatIstTime(ms: number, withSeconds = true): string {
  const p = istParts(ms);
  const base = `${pad(p.hours)}:${pad(p.minutes)}`;
  return withSeconds ? `${base}:${pad(p.seconds)}` : base;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDayKey(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function formatIstDateTime(ms: number): string {
  const p = istParts(ms);
  return `${p.day} ${MONTHS[p.month - 1]}, ${formatIstTime(ms, false)}`;
}

/** Short relative age such as "12s", "4m", "2h". */
export function formatAge(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
