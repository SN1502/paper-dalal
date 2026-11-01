/** When scheduled AI sessions run. Pure, so it can be tested. */
import { SESSION, isWeekday, istDayKey, istParts } from '../lib/time';
import type { AiRun, AiSettings } from './types';

/** Scheduled run times, minutes after IST midnight: 9:30 AM and 2:45 PM. */
export const SLOTS: Record<AiSettings['schedule'], number[]> = {
  morning: [9 * 60 + 30],
  twice: [9 * 60 + 30, 14 * 60 + 45],
};

const RETRY_AFTER_MS = 20 * 60_000;
const MAX_ATTEMPTS = 3;

/** The schedule slot that should run now, or null. Each slot runs once per trading day. */
export function dueSlot(now: number, settings: AiSettings, journal: AiRun[]): number | null {
  if (!isWeekday(now)) return null;
  const m = istParts(now).minuteOfDay;
  const day = istDayKey(now);
  const slots = SLOTS[settings.schedule] ?? SLOTS.morning;
  for (let k = slots.length - 1; k >= 0; k--) {
    const slot = slots[k];
    if (m < slot) continue;
    const windowEnd = k < slots.length - 1 ? slots[k + 1] : SESSION.close - 10;
    if (m >= windowEnd) return null;
    const runs = journal.filter((r) => r.day === day && r.slot === slot && r.trigger !== 'manual');
    if (runs.some((r) => r.status === 'completed' || r.status === 'running' || r.status === 'stopped')) return null;
    const failed = runs.filter((r) => r.status === 'failed' || r.status === 'interrupted');
    if (failed.length >= MAX_ATTEMPTS) return null;
    const last = failed[0];
    if (last && now - (last.finishedAt ?? last.startedAt) < RETRY_AFTER_MS) return null;
    return slot;
  }
  return null;
}

/** The next scheduled run time (epoch ms) from now, ignoring holidays. */
export function nextRunAt(now: number, settings: AiSettings, journal: AiRun[]): number {
  const slots = SLOTS[settings.schedule] ?? SLOTS.morning;
  const DAY = 86_400_000;
  for (let d = 0; d < 8; d++) {
    const t = now + d * DAY;
    if (!isWeekday(t)) continue;
    const day = istDayKey(t);
    const [y, mo, dd] = day.split('-').map(Number);
    const midnight = Date.UTC(y, mo - 1, dd) - 330 * 60_000;
    for (const slot of slots) {
      const at = midnight + slot * 60_000;
      if (d === 0 && dueSlot(now, settings, journal) === slot) return now;
      if (at > now) return at;
    }
  }
  return now + DAY;
}

