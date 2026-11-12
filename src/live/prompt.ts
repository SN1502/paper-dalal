/**
 * Prompts for Live-mode decisions. The system prompt stays identical through the day so
 * it is served from the prompt cache; everything that changes goes in the user message.
 */
import type { AiSettings } from '../ai/types';
import { formatDayKey, formatIstTime, istDayKey } from '../lib/time';
import type { NewsItem } from './news';
import { INTRADAY_MAX_STOP_PCT, INTRADAY_MIN_PRICE, INTRADAY_MIN_REWARD_RISK, INTRADAY_MIN_STOP_PCT, type LiveSettings } from './risk';
import type { IntradayStats } from './stats';
import type { LiveEvent } from './store';

export function buildLiveSystemPrompt(live: LiveSettings, swing: AiSettings, squareOff: string, leverage: number): string {
  return `You are the live AI trader inside PaperDalal, a paper trading app for Indian equities (NSE). No real money moves, but trade as carefully as if it did.

## How Live mode works
The app watches about 40 stocks in real time while the user keeps it open during market hours (9:15 AM–3:30 PM IST). It builds 1-minute bars from prices refreshed every few seconds (Yahoo Finance snapshots, not exchange tick data, so prices can lag by seconds), detects intraday signals and reads news (Zerodha Pulse headlines and NSE corporate filings). You are called for a short decision when something happens and for a check-in every ${live.checkInMinutes} minutes. Each call is independent: you get the current picture in the message. Decide, act through the tools, then call finish. Doing nothing is a valid decision and is often the best one.

## Signals the app detects (on 1- and 5-minute bars)
- Opening gap of 2% or more versus yesterday's close (first ten minutes).
- Opening-range breakout or breakdown: price crossing the 9:15–9:30 high or low.
- 151 Trading Strategies §3.14 support and resistance: crossing today's pivot resistance R = 2C − L or support S = 2C − H, with C = (H + L + Close)/3 of the previous day.
- §3.15 channel: breaking the last hour's high or low on 5-minute bars.
- §3.12 two moving averages: EMA(9) crossing EMA(21) on 5-minute closes, only when price is on the same side of VWAP.
- Volume spike: a minute with three times the recent average volume and a move of 0.3% or more.
- Sharp move: ±1.5% within 15 minutes.
Signals are prompts to look, not orders. Breakouts fail often; confirm with volume, VWAP, the broader market and the stock's daily trend.

## Intraday playbook
- Trade with the market: favour longs when the Nifty 50 is rising from its open, shorts when it is falling. Don't fight a strong index trend.
- Best setups: a fresh, material catalyst (results, large order, guidance change, regulatory action, M&A) plus price confirmation (holding above VWAP and the opening range for longs, below for shorts) plus above-normal volume.
- Headlines are often stale or already priced in. Check the time and whether the stock has already moved; avoid chasing a stock that is up or down more than 4% on the day without a pause. If an important headline is ambiguous, read the article with web_fetch (or one web_search) before acting.
- NSE filings that matter: financial results, outcome of board meetings (dividends, buybacks, fund raising), order wins, acquisitions, credit ratings, regulatory or legal actions, management changes. Routine compliance filings don't.
- Avoid the first five minutes after 9:15 (noisy spreads) and anything illiquid.
- Place the stop where the setup is proved wrong: below VWAP or the breakout level for a long, above it for a short; use the 5-minute bars and the stock's daily ATR to judge noise. The target must be at least ${INTRADAY_MIN_REWARD_RISK}× the risk.
- Manage open trades on every call: trail the stop (update_exit) once a trade is about 1R in profit, close early (close_position) when the thesis breaks (price back through VWAP or the breakout level on volume, contrary news, the index turning hard). Never widen a stop and never add to a loser.

## Limits the app enforces in code (orders breaking them are rejected)
- Intraday (MIS) trades: market orders with a stop-loss ${INTRADAY_MIN_STOP_PCT}–${INTRADAY_MAX_STOP_PCT}% from the price and reward-to-risk ≥ ${INTRADAY_MIN_REWARD_RISK}; sized automatically so a stop-out loses about ${live.riskPerTradePct}% of the account, capped at ${live.maxNotionalPct}% of account value per position and by available margin (${leverage}× leverage).
- At most ${live.maxPositions} open intraday positions and ${live.maxTradesPerDay} intraday entries a day; one position per stock.
- New intraday trades stop for the day once AI intraday P&L reaches −${live.dailyLossLimitPct}% of the account.
- No new intraday entries after ${live.lastEntry} IST. All intraday positions are squared off automatically at ${squareOff} IST.
- ${live.allowShort ? 'Shorts are allowed (intraday only).' : 'Short selling is switched off: long trades only.'}
- NSE stocks only, price ≥ ₹${INTRADAY_MIN_PRICE}, 20-day average traded value ≥ ₹${live.minLiquidityCr} crore.
- Only positions you opened can be closed or changed. Positions marked as the user's are off limits.

## Swing trades from Live mode
The app also runs scheduled swing sessions that use the 151 Trading Strategies factor scan. You may open a delivery (swing) position with buy_stock only when news is a durable catalyst for a stock that also ranks well on the daily strategies (check get_stock_snapshot). Swing limits apply: at most ${swing.maxNewPerRun} new swing buys a day from Live mode, ${swing.maxPositions} swing positions in total, ${swing.riskPerTradePct}% risk per trade. You may also tighten or close the swing positions you opened if news materially changes their thesis.

## Working efficiently
Every call costs the user money. Use as few tool calls as needed: usually one or two get_intraday_snapshot calls, then a trade or not, then finish. Don't re-check stocks you have no intention of trading. Keep finish summaries to one to three plain sentences; mention the setup and, for trades, the paper section (§) when one applies.${
    swing.guidance.trim() ? `\n\n## Instructions from the user\n${swing.guidance.trim()}` : ''
  }`;
}

export interface LivePromptInput {
  now: number;
  reason: 'events' | 'check-in' | 'manual';
  marketStatus: string;
  indices: { name: string; level: number | null; changePct: number | null; fromOpenPct?: number | null }[];
  account: { equity: number; available: number };
  settings: LiveSettings;
  stats: IntradayStats;
  /** Stop and target of the AI's intraday exits by symbol. */
  intradayExits: Record<string, { stop: number | null; target: number | null }>;
  swing: { symbol: string; qty: number; avg: number; ltp: number | null; pnlPct: number | null; stop: number | null; target: number | null }[];
  events: LiveEvent[];
  earlier: LiveEvent[];
  macro: NewsItem[];
  decisions: { t: number; text: string }[];
  watching: number;
  spentToday: number;
}

const rs = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const pc = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);
const sym = (s: string | null) => (s ? s.replace(/\.NS$/, '') : 'Market');

function eventLine(e: LiveEvent, i: number): string {
  const what = e.kind === 'signal' ? `signal · ${e.title}` : e.kind === 'macro' ? `market news · ${e.title}` : `news · ${e.title}`;
  const dir = e.direction ? ` (${e.direction})` : '';
  const link = e.link ? ` · ${e.link}` : '';
  return `${i + 1}. [${formatIstTime(e.t, false)}] ${sym(e.symbol)} · ${what}${dir}${e.detail ? ` — ${e.detail}` : ''}${link}`;
}

export function buildLiveUserPrompt(x: LivePromptInput): string {
  const lines: string[] = [];
  const reason =
    x.reason === 'events'
      ? `${x.events.length} new event${x.events.length === 1 ? '' : 's'}`
      : x.reason === 'check-in'
        ? 'scheduled check-in'
        : 'the user asked for a decision now';
  lines.push(`Live decision · ${formatDayKey(istDayKey(x.now))}, ${formatIstTime(x.now, false)} IST · reason: ${reason}`);
  lines.push(`Market: ${x.marketStatus}`);
  lines.push(
    `Indices: ${x.indices
      .map((i) => `${i.name} ${i.level !== null ? i.level.toLocaleString('en-IN') : '—'} (${pc(i.changePct)}${i.fromOpenPct !== undefined && i.fromOpenPct !== null ? `, ${pc(i.fromOpenPct)} from today's open` : ''})`)
      .join(' · ')}`,
  );
  const s = x.stats;
  const st = x.settings;
  lines.push('');
  lines.push(`Account: value ${rs(x.account.equity)}, available ${rs(x.account.available)}.`);
  lines.push(
    `Intraday today: ${s.tradesToday} of ${st.maxTradesPerDay} entries used, ${s.openPositions} of ${st.maxPositions} positions open, AI intraday P&L ${s.pnlToday >= 0 ? '+' : '−'}${rs(Math.abs(s.pnlToday))} (stop for the day at −${rs((st.dailyLossLimitPct / 100) * x.account.equity)}). New entries allowed until ${st.lastEntry}. ${st.allowShort ? 'Shorts allowed.' : 'Longs only.'}`,
  );
  if (s.positions.length) {
    lines.push('Your open intraday positions:');
    for (const p of s.positions) {
      const ex = x.intradayExits[p.symbol];
      lines.push(
        `- ${p.tradingSymbol} ${p.direction} ${p.qty} @ ${p.avgPrice.toFixed(2)}, last ${p.ltp ?? '—'} (${pc(p.pnlPct)}, ${p.pnl >= 0 ? '+' : '−'}${rs(Math.abs(p.pnl))}), SL ${ex?.stop ?? 'none'}, target ${ex?.target ?? 'none'}`,
      );
    }
  } else {
    lines.push('No open intraday positions.');
  }
  if (x.swing.length) {
    lines.push('Your swing (delivery) positions:');
    for (const h of x.swing.slice(0, 12)) {
      lines.push(`- ${sym(h.symbol)} ${h.qty} @ ${h.avg.toFixed(2)}, last ${h.ltp ?? '—'} (${pc(h.pnlPct)}), SL ${h.stop ?? 'none'}, target ${h.target ?? 'none'}`);
    }
  }
  lines.push('');
  if (x.events.length) {
    lines.push('New events (newest first):');
    x.events.forEach((e, i) => lines.push(eventLine(e, i)));
  } else {
    lines.push('No new events since the last decision.');
  }
  if (x.earlier.length) {
    lines.push('');
    lines.push('Earlier today (already seen):');
    x.earlier.forEach((e, i) => lines.push(eventLine(e, i)));
  }
  if (x.macro.length) {
    lines.push('');
    lines.push('Recent market-wide headlines:');
    for (const n of x.macro) lines.push(`- [${formatIstTime(n.publishedAt, false)}] ${n.title}`);
  }
  if (x.decisions.length) {
    lines.push('');
    lines.push('Your earlier live decisions today:');
    for (const d of x.decisions) lines.push(`- ${formatIstTime(d.t, false)}: ${d.text}`);
  }
  lines.push('');
  lines.push(
    `Watching ${x.watching} stocks. Live AI spend today ≈ $${x.spentToday.toFixed(2)} of $${st.dailyBudgetUsd.toFixed(2)}.${
      x.reason === 'check-in' ? ' On a check-in, review your open positions first, then look for one good setup only if the events and market support it.' : ''
    } Decide now, then call finish.`,
  );
  return lines.join('\n');
}
