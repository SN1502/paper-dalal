import type { ModelId } from './claude';

export interface AiSettings {
  /** Run automatically on schedule. */
  enabled: boolean;
  model: ModelId;
  /** 'morning' = 9:30 AM; 'twice' = 9:30 AM and 2:45 PM (IST, trading days). */
  schedule: 'morning' | 'twice';
  /** Web searches allowed per run. */
  maxSearches: number;
  /** Largest position as % of account value. */
  maxPositionPct: number;
  /** Most the account may lose if a stop-loss is hit, as % of account value. */
  riskPerTradePct: number;
  /** Most AI positions held at once. */
  maxPositions: number;
  /** Most new buys in one run. */
  maxNewPerRun: number;
  /** Cash kept aside, as % of account value. */
  cashReservePct: number;
  /** Auto-trading pauses when the account is down this much from its starting capital. */
  maxDrawdownPct: number;
  /** Auto runs stop for the month once estimated API spend reaches this (USD). */
  monthlyBudgetUsd: number;
  /** A run stops making Claude calls once it has cost this much (USD). */
  perRunCapUsd: number;
  /** Minimum 20-day average traded value, in ₹ crore. */
  minLiquidityCr: number;
  /** Free-text instructions from the user, e.g. "avoid PSU banks". */
  guidance: string;
  /**
   * Dual-momentum market filter (151 Trading Strategies §4.1.2): while the Nifty 50 is below
   * its 100- and 200-day averages, new stock buys are blocked and only gold/silver ETFs allowed.
   */
  regimeFilter: boolean;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: true,
  model: 'claude-sonnet-5-5',
  schedule: 'morning',
  maxSearches: 8,
  maxPositionPct: 10,
  riskPerTradePct: 1,
  maxPositions: 8,
  maxNewPerRun: 2,
  cashReservePct: 20,
  maxDrawdownPct: 15,
  monthlyBudgetUsd: 20,
  perRunCapUsd: 1.5,
  minLiquidityCr: 10,
  guidance: '',
  regimeFilter: true,
};

export type StepKind = 'search' | 'fetch' | 'tool' | 'order' | 'note' | 'error';

export interface AiStep {
  t: number;
  kind: StepKind;
  text: string;
}

export interface AiDecision {
  symbol: string;
  action: 'BUY' | 'SELL' | 'UPDATE_EXIT';
  qty: number | null;
  price: number | null;
  stop: number | null;
  target: number | null;
  conviction: number | null;
  rationale: string;
  orderId: string | null;
  outcome: 'filled' | 'queued' | 'rejected' | 'updated';
  error: string | null;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  searches: number;
  fetches: number;
  requests: number;
  costUsd: number;
}

export type RunTrigger = 'auto' | 'manual' | 'background';

export interface AiRun {
  id: string;
  trigger: RunTrigger;
  /** Schedule slot (minutes after IST midnight) an automatic run was for. */
  slot: number | null;
  day: string;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
  model: string;
  marketView: string | null;
  summary: string | null;
  watchNext: string[];
  steps: AiStep[];
  decisions: AiDecision[];
  usage: AiUsage;
  error: string | null;
}

export const EMPTY_USAGE: AiUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  searches: 0,
  fetches: 0,
  requests: 0,
  costUsd: 0,
};
