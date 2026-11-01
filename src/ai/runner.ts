/**
 * Decides when the AI trader runs and wires it to the app's engine, prices and orders.
 */
import { BENCHMARK } from '../data/instruments';
import { yahooCandles, yahooSearch } from '../data/yahoo';
import { controller, marketStatus, type MarketStatus } from '../state/controller';
import { engineStore } from '../state/engineStore';
import { quoteStore } from '../state/quoteStore';
import { toastStore } from '../state/uiStores';
import { accountSummary } from '../engine/selectors';
import { runAgent } from './agent';
import { dueSlot } from './schedule';
import { drawdownPaused } from './risk';
import { strategyStore } from '../strategies/store';
import { aiStore, monthSpend } from './store';
import type { AgentEnv } from './tools';
import type { AiRun, RunTrigger } from './types';

const STATUS_TEXT: Record<MarketStatus, string> = {
  open: 'open (live prices)',
  'pre-open': 'pre-open; the session starts at 9:15 AM',
  closed: 'closed; orders queue for the next open',
  weekend: 'closed for the weekend; orders queue for Monday’s open',
  holiday: 'closed for a market holiday; orders queue for the next open',
};

export type AiStatus = 'no-key' | 'off' | 'running' | 'paused-budget' | 'paused-drawdown' | 'on';

export function aiStatus(): AiStatus {
  const s = aiStore.get();
  if (!s.hasKey) return 'no-key';
  if (s.running) return 'running';
  if (!s.settings.enabled) return 'off';
  if (monthSpend(s.journal, Date.now()) >= s.settings.monthlyBudgetUsd) return 'paused-budget';
  if (engineStore.isReady()) {
    const sum = accountSummary(engineStore.get(), quoteStore.record());
    if (drawdownPaused(sum.equity, sum.startingCapital, s.settings)) return 'paused-drawdown';
  }
  return 'on';
}

function makeEnv(): AgentEnv {
  return {
    now: () => Date.now(),
    getState: () => engineStore.get(),
    quotes: () => quoteStore.record(),
    instrumentFor: (symbol) => controller.instrumentFor(symbol),
    getQuote: (inst) => controller.quoteFor(inst),
    getDailyCandles: async (symbol) => (await yahooCandles(symbol, '2y', '1d')).candles,
    search: (q) => yahooSearch(q),
    placeOrder: (input) => controller.placeOrder(input),
    updateGtt: (id, patch) => controller.updateGtt(id, patch),
    marketStatus: () => STATUS_TEXT[marketStatus(Date.now(), quoteStore.get(BENCHMARK))],
    getScan: () => strategyStore.ensureFresh(),
    saveFundamentals: (symbol, record) => strategyStore.saveFundamentals(symbol, record),
  };
}

class AiRunner {
  private abort: AbortController | null = null;
  private current: Promise<AiRun | null> | null = null;

  isRunning(): boolean {
    return this.current !== null;
  }

  private checking = false;

  /** Called after every price refresh and from the background task. */
  async maybeAutoRun(trigger: Exclude<RunTrigger, 'manual'>): Promise<void> {
    if (this.checking || this.current) return;
    this.checking = true;
    try {
      await this.checkAndRun(trigger);
    } finally {
      this.checking = false;
    }
  }

  private async checkAndRun(trigger: Exclude<RunTrigger, 'manual'>): Promise<void> {
    await aiStore.load();
    const s = aiStore.get();
    if (!s.settings.enabled || !s.hasKey || this.current || !engineStore.isReady()) return;
    const now = Date.now();
    if (marketStatus(now, quoteStore.get(BENCHMARK)) !== 'open') return;
    const slot = dueSlot(now, s.settings, s.journal);
    if (slot === null) return;
    const status = aiStatus();
    if (status === 'paused-budget' || status === 'paused-drawdown') return;
    await this.run(trigger, slot);
  }

  /** Starts a run immediately (doesn't wait for it to finish). */
  async runNow(): Promise<string | null> {
    await aiStore.load();
    if (!aiStore.get().hasKey) return 'Add your Claude API key first.';
    if (this.current) return 'A session is already running.';
    void this.run('manual', null);
    return null;
  }

  stop() {
    this.abort?.abort();
  }

  /** Waits for a running session, if any (used by the background task). */
  async settle(): Promise<void> {
    if (this.current) await this.current;
  }

  private run(trigger: RunTrigger, slot: number | null): Promise<AiRun | null> {
    const p = (async () => {
      const apiKey = await aiStore.getApiKey();
      if (!apiKey) return null;
      const abort = new AbortController();
      this.abort = abort;
      const s = aiStore.get();
      const previous = s.journal.find((r) => r.status === 'completed') ?? null;
      try {
        const run = await runAgent({
          apiKey,
          settings: s.settings,
          env: makeEnv(),
          trigger,
          slot,
          previous,
          signal: abort.signal,
          onUpdate: (r) => {
            aiStore.setRunning(r);
            aiStore.upsertRun(r);
          },
        });
        aiStore.upsertRun(run);
        announce(run);
        return run;
      } finally {
        aiStore.setRunning(null);
        this.abort = null;
        await aiStore.flush();
        await engineStore.flush();
      }
    })();
    this.current = p;
    p.finally(() => {
      if (this.current === p) this.current = null;
    }).catch(() => undefined);
    return p;
  }
}

function announce(run: AiRun) {
  const buys = run.decisions.filter((d) => d.action === 'BUY' && d.outcome !== 'rejected').length;
  const sells = run.decisions.filter((d) => d.action === 'SELL' && d.outcome !== 'rejected').length;
  const cost = `$${run.usage.costUsd.toFixed(2)}`;
  if (run.status === 'failed') {
    toastStore.push([{ id: `ai-${run.id}`, kind: 'reject', title: 'AI session failed', body: run.error ?? 'Unknown error' }]);
    return;
  }
  const what = buys || sells ? `${buys} buy${buys === 1 ? '' : 's'}, ${sells} sell${sells === 1 ? '' : 's'}` : 'no trades';
  toastStore.push([
    {
      id: `ai-${run.id}`,
      kind: 'info',
      title: run.status === 'stopped' ? 'AI session stopped' : 'AI session finished',
      body: `${what} · est. cost ${cost} · see the AI tab`,
    },
  ]);
}

export const aiRunner = new AiRunner();
