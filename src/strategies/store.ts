import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { fetchDailyHistory } from '../data/history';
import { BENCHMARK, STRATEGY_UNIVERSE, sectorOf } from '../data/instruments';
import { istDayKey } from '../lib/time';
import type { FundamentalScore } from './fundamentals';
import { computeScan, type ScanResult, type StockSignal } from './scan';

const SCAN_KEY = 'paperdalal/strategy/scan/v1';
const FUND_KEY = 'paperdalal/strategy/fundamentals/v1';
const STALE_MS = 4 * 60 * 60_000;

export interface FundamentalRecord {
  score: FundamentalScore;
  at: number;
  source: string | null;
  extras: Record<string, number | string | null>;
}

export interface StrategyState {
  loaded: boolean;
  scan: ScanResult | null;
  status: 'idle' | 'loading' | 'error';
  progress: { done: number; total: number } | null;
  error: string | null;
  fundamentals: Record<string, FundamentalRecord>;
}

let state: StrategyState = { loaded: false, scan: null, status: 'idle', progress: null, error: null, fundamentals: {} };
const listeners = new Set<() => void>();

function set(patch: Partial<StrategyState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

let loading: Promise<void> | null = null;
let running: Promise<ScanResult | null> | null = null;

export const strategyStore = {
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
        let scan: ScanResult | null = null;
        let fundamentals: Record<string, FundamentalRecord> = {};
        try {
          const raw = await AsyncStorage.getItem(SCAN_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed?.version === 1 && Array.isArray(parsed.stocks)) scan = parsed;
          }
          const rawF = await AsyncStorage.getItem(FUND_KEY);
          if (rawF) fundamentals = JSON.parse(rawF);
        } catch {
          // A missing cache just means the first scan runs from scratch.
        }
        set({ loaded: true, scan, fundamentals });
      })();
    }
    return loading;
  },

  isStale(now = Date.now()): boolean {
    const s = state.scan;
    if (!s) return true;
    return now - s.computedAt > STALE_MS || istDayKey(s.computedAt) !== istDayKey(now);
  },

  /** Runs a scan if the cached one is stale (or `force`). Concurrent callers share one run. */
  async ensureFresh(force = false): Promise<ScanResult | null> {
    await strategyStore.load();
    if (!force && !strategyStore.isStale()) return state.scan;
    if (running) return running;
    running = (async () => {
      set({ status: 'loading', error: null, progress: { done: 0, total: STRATEGY_UNIVERSE.length + 1 } });
      try {
        const symbols = [BENCHMARK, ...STRATEGY_UNIVERSE.map((i) => i.symbol)];
        const { history } = await fetchDailyHistory(symbols, (done, total) => set({ progress: { done, total } }));
        const result = computeScan({
          universe: STRATEGY_UNIVERSE.map((i) => ({
            symbol: i.symbol,
            tradingSymbol: i.tradingSymbol,
            name: i.name,
            sector: sectorOf(i.symbol) ?? 'Other',
          })),
          history,
          benchmark: history[BENCHMARK] ?? null,
          computedAt: Date.now(),
        });
        if (!result || result.covered === 0) throw new Error('Not enough price history came back to rank stocks. Check your connection and try again.');
        set({ scan: result, status: 'idle', progress: null, error: null });
        AsyncStorage.setItem(SCAN_KEY, JSON.stringify(result)).catch(() => undefined);
        return result;
      } catch (e) {
        set({ status: 'error', progress: null, error: e instanceof Error ? e.message : 'Scan failed' });
        return state.scan;
      } finally {
        running = null;
      }
    })();
    return running;
  },

  signalFor(symbol: string): StockSignal | null {
    return state.scan?.stocks.find((s) => s.symbol === symbol) ?? null;
  },

  saveFundamentals(symbol: string, record: FundamentalRecord) {
    const fundamentals = { ...state.fundamentals, [symbol]: record };
    set({ fundamentals });
    AsyncStorage.setItem(FUND_KEY, JSON.stringify(fundamentals)).catch(() => undefined);
  },
};

export function useStrategies(): StrategyState {
  return useSyncExternalStore(strategyStore.subscribe, strategyStore.get);
}
