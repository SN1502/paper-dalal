import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import type { Quote } from '../engine/types';

const KEY = 'paperdalal/quotes/v1';

type Listener = () => void;

let quotes: Record<string, Quote> = {};
let version = 0;
const listeners = new Set<Listener>();

function emit() {
  version++;
  for (const l of listeners) l();
}

export const quoteStore = {
  get(symbol: string): Quote | undefined {
    return quotes[symbol];
  },
  /** Immutable snapshot; a new object after every update. */
  record(): Record<string, Quote> {
    return quotes;
  },
  version(): number {
    return version;
  },
  setMany(list: Quote[]) {
    if (list.length === 0) return;
    const next = { ...quotes };
    let changed = false;
    for (const q of list) {
      const prev = next[q.symbol];
      // Never let an older trade overwrite a newer one (e.g. a slower fallback source).
      if (prev && prev.time > q.time && q.time !== 0) continue;
      next[q.symbol] = q;
      changed = true;
    }
    if (!changed) return;
    quotes = next;
    emit();
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  async load() {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Record<string, Quote>;
      if (saved && typeof saved === 'object') {
        quotes = { ...saved, ...quotes };
        emit();
      }
    } catch {
      // A missing or corrupt cache only means prices appear after the first refresh.
    }
  },
  async save() {
    try {
      await AsyncStorage.setItem(KEY, JSON.stringify(quotes));
    } catch {
      // Cache only; safe to skip.
    }
  },
};

export function useQuote(symbol: string | undefined): Quote | undefined {
  return useSyncExternalStore(quoteStore.subscribe, () => (symbol ? quotes[symbol] : undefined));
}

export function useQuotes(): Record<string, Quote> {
  return useSyncExternalStore(quoteStore.subscribe, () => quotes);
}
