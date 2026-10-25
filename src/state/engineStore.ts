import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { DEFAULT_WATCHLIST } from '../data/instruments';
import { DEFAULT_SETTINGS, createInitialState } from '../engine/engine';
import type { EngineState } from '../engine/types';

const KEY = 'paperdalal/engine/v1';
const META_KEY = 'paperdalal/meta/v1';

type Listener = () => void;

let state: EngineState | null = null;
const listeners = new Set<Listener>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveError: string | null = null;

function emit() {
  for (const l of listeners) l();
}

function isValid(x: any): x is EngineState {
  return (
    x &&
    x.schemaVersion === 1 &&
    x.account &&
    typeof x.account.cash === 'number' &&
    Array.isArray(x.orders) &&
    Array.isArray(x.fills) &&
    x.positions &&
    x.holdings &&
    Array.isArray(x.watchlist) &&
    typeof x.tradingDay === 'string'
  );
}

async function writeNow() {
  if (!state) return;
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(state));
    saveError = null;
  } catch (e) {
    saveError = e instanceof Error ? e.message : 'Could not save';
  }
}

export interface Meta {
  /** Last time orders were checked against live prices. Used for catch-up after the app was closed. */
  lastEvalAt: number;
}

let meta: Meta = { lastEvalAt: 0 };

export const engineStore = {
  get(): EngineState {
    if (!state) throw new Error('Engine state used before hydrate()');
    return state;
  },
  isReady(): boolean {
    return state !== null;
  },
  set(next: EngineState) {
    if (next === state) return;
    state = next;
    emit();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void writeNow();
    }, 400);
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  async flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await writeNow();
    await AsyncStorage.setItem(META_KEY, JSON.stringify(meta)).catch(() => undefined);
  },
  lastSaveError(): string | null {
    return saveError;
  },
  meta(): Meta {
    return meta;
  },
  setMeta(patch: Partial<Meta>) {
    meta = { ...meta, ...patch };
    AsyncStorage.setItem(META_KEY, JSON.stringify(meta)).catch(() => undefined);
  },
  async hydrate(): Promise<void> {
    let loaded: EngineState | null = null;
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (isValid(parsed)) loaded = { ...parsed, settings: { ...DEFAULT_SETTINGS, ...parsed.settings } };
      }
      const rawMeta = await AsyncStorage.getItem(META_KEY);
      if (rawMeta) meta = { ...meta, ...JSON.parse(rawMeta) };
    } catch {
      loaded = null;
    }
    state = loaded ?? createInitialState(Date.now(), DEFAULT_SETTINGS, DEFAULT_WATCHLIST);
    emit();
    if (!loaded) await writeNow();
  },
};

export function useEngine(): EngineState {
  return useSyncExternalStore(engineStore.subscribe, engineStore.get);
}
