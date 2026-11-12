/**
 * Live mode state: settings, whether it's switched on, the event feed, news, the AI's live
 * decisions and spend per day. Persisted so a restart picks up where it left off.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import type { AiRun } from '../ai/types';
import { istDayKey } from '../lib/time';
import type { NewsItem, NewsSource } from './news';
import { DEFAULT_LIVE_SETTINGS, type LiveSettings } from './risk';

const SETTINGS_KEY = 'paperdalal/live/settings/v1';
const STATE_KEY = 'paperdalal/live/state/v1';
const KEEP_RUNS = 150;
const KEEP_EVENTS = 250;
const KEEP_NEWS = 150;
const KEEP_SEEN = 1500;
const KEEP_SPEND_DAYS = 70;
const DAY_MS = 24 * 60 * 60_000;

export type LivePhase = 'off' | 'waiting' | 'starting' | 'watching' | 'thinking' | 'paused';

export interface LiveEvent {
  id: string;
  t: number;
  kind: 'signal' | 'news' | 'macro';
  /** ".NS" symbol, or null for market-wide news. */
  symbol: string | null;
  title: string;
  detail: string;
  direction: 'long' | 'short' | null;
  /** 3 = touches an AI position, 2 = worth a decision now, 1 = context for the next check-in. */
  priority: 1 | 2 | 3;
  link: string | null;
  /** The live decision that saw this event. */
  runId: string | null;
}

export interface FeedHealth {
  lastOkAt: number | null;
  lastError: string | null;
}

export interface LiveState {
  loaded: boolean;
  settings: LiveSettings;
  /** The user switched Live mode on; it runs whenever the app is open in market hours. */
  armed: boolean;
  phase: LivePhase;
  phaseText: string;
  events: LiveEvent[];
  news: NewsItem[];
  runs: AiRun[];
  /** Estimated live API spend per IST day, USD. */
  spend: Record<string, number>;
  thinking: AiRun | null;
  watching: number;
  lastDecisionAt: number | null;
  nextCheckInAt: number | null;
  feeds: Record<NewsSource, FeedHealth>;
}

interface Persisted {
  armed: boolean;
  events: LiveEvent[];
  news: NewsItem[];
  runs: AiRun[];
  spend: Record<string, number>;
  seen: string[];
  lastDecisionAt: number | null;
}

let state: LiveState = {
  loaded: false,
  settings: DEFAULT_LIVE_SETTINGS,
  armed: false,
  phase: 'off',
  phaseText: 'Off',
  events: [],
  news: [],
  runs: [],
  spend: {},
  thinking: null,
  watching: 0,
  lastDecisionAt: null,
  nextCheckInAt: null,
  feeds: { pulse: { lastOkAt: null, lastError: null }, nse: { lastOkAt: null, lastError: null } },
};
let seen: string[] = [];
const seenSet = new Set<string>();
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let loading: Promise<void> | null = null;

function emit() {
  for (const l of listeners) l();
}

function set(patch: Partial<LiveState>, persist = false) {
  state = { ...state, ...patch };
  emit();
  if (persist) scheduleSave();
}

async function saveNow() {
  const now = Date.now();
  const days = Object.keys(state.spend).sort().slice(-KEEP_SPEND_DAYS);
  const data: Persisted = {
    armed: state.armed,
    // Only the last day's events matter after a restart (overnight news feeds the first decision).
    events: state.events.filter((e) => now - e.t < DAY_MS).slice(0, KEEP_EVENTS),
    news: state.news.slice(0, KEEP_NEWS),
    runs: state.runs.slice(0, KEEP_RUNS),
    spend: Object.fromEntries(days.map((d) => [d, state.spend[d]])),
    seen: seen.slice(-KEEP_SEEN),
    lastDecisionAt: state.lastDecisionAt,
  };
  try {
    await AsyncStorage.setItem(STATE_KEY, JSON.stringify(data));
  } catch {
    // A failed write only loses history.
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveNow();
  }, 1000);
}

export const liveStore = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },

  load(): Promise<void> {
    if (!loading) {
      loading = (async () => {
        let settings = DEFAULT_LIVE_SETTINGS;
        let saved: Partial<Persisted> = {};
        try {
          const raw = await AsyncStorage.getItem(SETTINGS_KEY);
          if (raw) settings = { ...DEFAULT_LIVE_SETTINGS, ...JSON.parse(raw) };
          const rawS = await AsyncStorage.getItem(STATE_KEY);
          if (rawS) saved = JSON.parse(rawS) ?? {};
        } catch {
          // Defaults.
        }
        seen = Array.isArray(saved.seen) ? saved.seen.filter((x): x is string => typeof x === 'string') : [];
        seenSet.clear();
        for (const id of seen) seenSet.add(id);
        const now = Date.now();
        const runs = (Array.isArray(saved.runs) ? saved.runs : []).map((r) =>
          r.status === 'running' ? { ...r, status: 'interrupted' as const, finishedAt: r.finishedAt ?? r.startedAt } : r,
        );
        set({
          loaded: true,
          settings,
          armed: !!saved.armed,
          phase: saved.armed ? 'waiting' : 'off',
          phaseText: saved.armed ? 'Starting…' : 'Off',
          events: (Array.isArray(saved.events) ? saved.events : []).filter((e) => now - e.t < DAY_MS),
          news: Array.isArray(saved.news) ? saved.news : [],
          runs,
          spend: saved.spend && typeof saved.spend === 'object' ? saved.spend : {},
          lastDecisionAt: typeof saved.lastDecisionAt === 'number' ? saved.lastDecisionAt : null,
        });
      })();
    }
    return loading;
  },

  updateSettings(patch: Partial<LiveSettings>) {
    const settings = { ...state.settings, ...patch };
    set({ settings });
    AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)).catch(() => undefined);
  },

  setArmed(armed: boolean) {
    set({ armed, phase: armed ? 'waiting' : 'off', phaseText: armed ? 'Starting…' : 'Off' }, true);
  },

  setPhase(phase: LivePhase, phaseText: string) {
    if (phase === state.phase && phaseText === state.phaseText) return;
    set({ phase, phaseText });
  },

  setRuntime(patch: Partial<Pick<LiveState, 'watching' | 'nextCheckInAt' | 'feeds' | 'thinking'>>) {
    set(patch);
  },

  /** The seen-id set is shared with the news merge so it survives restarts. */
  seenIds(): Set<string> {
    return seenSet;
  },

  /** Saves the merged news list; `addedIds` were just put in the seen set by the merge. */
  addNews(list: NewsItem[], addedIds: string[]) {
    seen.push(...addedIds);
    if (seen.length > KEEP_SEEN * 1.2) {
      seen = seen.slice(-KEEP_SEEN);
      seenSet.clear();
      for (const id of seen) seenSet.add(id);
    }
    set({ news: list }, true);
  },

  addEvents(events: LiveEvent[]) {
    if (events.length === 0) return;
    set({ events: [...events, ...state.events].slice(0, KEEP_EVENTS) }, true);
  },

  markEventsSeen(ids: string[], runId: string) {
    const want = new Set(ids);
    set({ events: state.events.map((e) => (want.has(e.id) ? { ...e, runId } : e)) }, true);
  },

  upsertRun(run: AiRun) {
    const idx = state.runs.findIndex((r) => r.id === run.id);
    const runs = idx >= 0 ? state.runs.map((r) => (r.id === run.id ? run : r)) : [run, ...state.runs].slice(0, KEEP_RUNS);
    set({ runs }, true);
  },

  /** Records the final cost of a finished decision against its day. */
  addSpend(day: string, usd: number) {
    if (!(usd > 0)) return;
    set({ spend: { ...state.spend, [day]: (state.spend[day] ?? 0) + usd } }, true);
  },

  setLastDecisionAt(t: number) {
    set({ lastDecisionAt: t }, true);
  },

  /** Clears decisions and events from before today (today's count towards the daily limits). */
  clearHistory() {
    const today = istDayKey(Date.now());
    set({ runs: state.runs.filter((r) => r.day === today), events: state.events.filter((e) => istDayKey(e.t) === today) }, true);
  },

  async flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await saveNow();
  },
};

export function useLive(): LiveState {
  return useSyncExternalStore(liveStore.subscribe, liveStore.get);
}

export function spendOn(s: Pick<LiveState, 'spend' | 'thinking'>, day: string): number {
  const running = s.thinking && s.thinking.day === day ? s.thinking.usage.costUsd : 0;
  return (s.spend[day] ?? 0) + running;
}

export function liveMonthSpend(spend: Record<string, number>, now: number): number {
  const month = istDayKey(now).slice(0, 7);
  return Object.entries(spend)
    .filter(([d]) => d.slice(0, 7) === month)
    .reduce((a, [, v]) => a + v, 0);
}
