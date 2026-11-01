import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

import { DEFAULT_AI_SETTINGS, type AiRun, type AiSettings } from './types';

const SETTINGS_KEY = 'paperdalal/ai/settings/v1';
const JOURNAL_KEY = 'paperdalal/ai/journal/v1';
const API_KEY_ITEM = 'paperdalal_anthropic_api_key';
const KEEP_RUNS = 60;

export interface AiState {
  loaded: boolean;
  settings: AiSettings;
  journal: AiRun[];
  hasKey: boolean;
  /** Last 4 characters of the key, for display. */
  keyHint: string | null;
  running: AiRun | null;
}

let state: AiState = {
  loaded: false,
  settings: DEFAULT_AI_SETTINGS,
  journal: [],
  hasKey: false,
  keyHint: null,
  running: null,
};
const listeners = new Set<() => void>();
let journalTimer: ReturnType<typeof setTimeout> | null = null;

function set(patch: Partial<AiState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

async function saveJournalNow() {
  try {
    await AsyncStorage.setItem(JOURNAL_KEY, JSON.stringify(state.journal.slice(0, KEEP_RUNS)));
  } catch {
    // Journal is a log; a failed write only loses history.
  }
}

function scheduleJournalSave() {
  if (journalTimer) clearTimeout(journalTimer);
  journalTimer = setTimeout(() => {
    journalTimer = null;
    void saveJournalNow();
  }, 500);
}

let loading: Promise<void> | null = null;

export const aiStore = {
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
        let settings = DEFAULT_AI_SETTINGS;
        let journal: AiRun[] = [];
        try {
          const raw = await AsyncStorage.getItem(SETTINGS_KEY);
          if (raw) settings = { ...DEFAULT_AI_SETTINGS, ...JSON.parse(raw) };
          const rawJ = await AsyncStorage.getItem(JOURNAL_KEY);
          if (rawJ) journal = JSON.parse(rawJ);
        } catch {
          // Fall back to defaults.
        }
        // A run still marked "running" belongs to a process that was killed.
        journal = journal.map((r) =>
          r.status === 'running' ? { ...r, status: 'interrupted' as const, finishedAt: r.finishedAt ?? r.startedAt } : r,
        );
        let key: string | null = null;
        try {
          key = await SecureStore.getItemAsync(API_KEY_ITEM);
        } catch {
          key = null;
        }
        set({ loaded: true, settings, journal, hasKey: !!key, keyHint: key ? key.slice(-4) : null });
      })();
    }
    return loading;
  },

  async getApiKey(): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(API_KEY_ITEM);
    } catch {
      return null;
    }
  },

  async setApiKey(key: string | null) {
    if (key) {
      await SecureStore.setItemAsync(API_KEY_ITEM, key, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
      set({ hasKey: true, keyHint: key.slice(-4) });
    } else {
      await SecureStore.deleteItemAsync(API_KEY_ITEM);
      set({ hasKey: false, keyHint: null });
    }
  },

  updateSettings(patch: Partial<AiSettings>) {
    const settings = { ...state.settings, ...patch };
    set({ settings });
    AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)).catch(() => undefined);
  },

  setRunning(run: AiRun | null) {
    set({ running: run });
  },

  /** Inserts or replaces a run in the journal (newest first). */
  upsertRun(run: AiRun) {
    const idx = state.journal.findIndex((r) => r.id === run.id);
    const journal = idx >= 0 ? state.journal.map((r) => (r.id === run.id ? run : r)) : [run, ...state.journal].slice(0, KEEP_RUNS);
    set({ journal });
    scheduleJournalSave();
  },

  async flush() {
    if (journalTimer) {
      clearTimeout(journalTimer);
      journalTimer = null;
    }
    await saveJournalNow();
  },

  clearJournal() {
    set({ journal: [] });
    void saveJournalNow();
  },
};

export function useAi(): AiState {
  return useSyncExternalStore(aiStore.subscribe, aiStore.get);
}

/** Estimated API spend in the current IST calendar month. */
export function monthSpend(journal: AiRun[], now: number): number {
  const month = new Date(now + 330 * 60_000).toISOString().slice(0, 7);
  return journal.filter((r) => r.day.slice(0, 7) === month).reduce((a, r) => a + (r.usage?.costUsd ?? 0), 0);
}
