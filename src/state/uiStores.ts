import { useSyncExternalStore } from 'react';

import type { EngineEvent } from '../engine/types';

/* ---------------- Toasts ---------------- */

export interface Toast extends EngineEvent {
  createdAt: number;
}

type Listener = () => void;

let toasts: Toast[] = [];
const toastListeners = new Set<Listener>();
const MAX_VISIBLE = 3;
const TTL_MS = 4500;

function emitToasts() {
  for (const l of toastListeners) l();
}

export const toastStore = {
  push(events: EngineEvent[]) {
    if (events.length === 0) return;
    const now = Date.now();
    let incoming = events;
    // A burst (catch-up replay, square-off) collapses into one summary line.
    if (incoming.length > MAX_VISIBLE) {
      const fills = incoming.filter((e) => e.kind === 'fill').length;
      const others = incoming.length - fills;
      incoming = [
        ...incoming.slice(0, MAX_VISIBLE - 1),
        {
          id: `sum-${now}`,
          kind: 'info',
          title: 'More updates',
          body: `${fills > 0 ? `${fills} fills` : ''}${fills > 0 && others > 0 ? ' and ' : ''}${others > 0 ? `${others} other updates` : ''} · see Orders`,
        },
      ];
    }
    toasts = [...incoming.map((e) => ({ ...e, createdAt: now })), ...toasts].slice(0, MAX_VISIBLE);
    emitToasts();
    setTimeout(() => {
      const cutoff = Date.now() - TTL_MS + 50;
      const next = toasts.filter((t) => t.createdAt > cutoff);
      if (next.length !== toasts.length) {
        toasts = next;
        emitToasts();
      }
    }, TTL_MS);
  },
  dismiss(id: string) {
    toasts = toasts.filter((t) => t.id !== id);
    emitToasts();
  },
  subscribe(l: Listener) {
    toastListeners.add(l);
    return () => toastListeners.delete(l);
  },
};

export function useToasts(): Toast[] {
  return useSyncExternalStore(toastStore.subscribe, () => toasts);
}

/* ---------------- Feed status ---------------- */

export interface FeedStatus {
  /** Source of the most recent successful batch. */
  source: 'yahoo' | 'google' | null;
  lastSuccessAt: number;
  lastAttemptAt: number;
  lastError: string | null;
  failing: string[];
  refreshing: boolean;
}

let feed: FeedStatus = {
  source: null,
  lastSuccessAt: 0,
  lastAttemptAt: 0,
  lastError: null,
  failing: [],
  refreshing: false,
};
const feedListeners = new Set<Listener>();

export const feedStatusStore = {
  get: () => feed,
  set(patch: Partial<FeedStatus>) {
    feed = { ...feed, ...patch };
    for (const l of feedListeners) l();
  },
  subscribe(l: Listener) {
    feedListeners.add(l);
    return () => feedListeners.delete(l);
  },
};

export function useFeedStatus(): FeedStatus {
  return useSyncExternalStore(feedStatusStore.subscribe, feedStatusStore.get);
}
