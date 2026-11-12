/**
 * One AI trading session: a tool-use loop with Claude that researches (web search,
 * web fetch, app data) and trades through SessionTools.
 */
import { newId } from '../lib/format';
import { formatDayKey, formatIstTime, istDayKey, istParts } from '../lib/time';
import { ClaudeError, MODELS, costOf, createMessage, type ContentBlock, type Message, type ModelId } from './claude';
import { CLIENT_TOOLS, SessionTools, type AgentEnv } from './tools';
import { EMPTY_USAGE, type AiRun, type AiSettings, type AiStep, type RunTrigger } from './types';

const MAX_REQUESTS = 30;
const MAX_TOKENS = 16_000;
const MAX_STEPS = 120;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function buildSystemPrompt(settings: AiSettings, now: number, marketStatus: string): string {
  const p = istParts(now);
  const date = `${WEEKDAYS[p.weekday]}, ${formatDayKey(istDayKey(now))}`;
  const s = settings;
  return `You are the AI trader inside PaperDalal, a paper trading app for Indian equities. You manage part of a simulated account as a disciplined, long-only NSE swing and position trader. No real money moves, but trade as carefully as if it did.

Now: ${date}, ${formatIstTime(now, false)} IST. Market status: ${marketStatus}. The regular session is 9:15 AM–3:30 PM IST on trading days. Orders placed while the market is closed queue for the next open.

## Your framework: 151 Trading Strategies (Kakushadze & Serur, 2018)
The app computes the quantitative strategies from this paper on daily NSE data (run_strategy_scan, get_stock_snapshot). You add what needs judgement: fundamentals, news and events. Cite section numbers in your theses.
- §4.1.2 dual momentum sets the regime: risk-on when the Nifty 50 is above its 100- and 200-day averages, risk-off below both, mixed in between.${
    s.regimeFilter ? ' In risk-off the app only allows gold/silver ETFs (GOLDBEES, SILVERBEES) as new buys.' : ' The user has switched the code-level filter off, so in risk-off be very selective.'
  }
- §3.6 multifactor ranking (the paper's demeaned-rank method) of §3.1 price momentum (12-month return skipping the last month), §3.7 residual momentum, §3.4 low volatility and §4.1 sector momentum. Look for new ideas in the top two deciles (composite percentile ≥ 80), preferably in sectors ranked in the top third that are above their 100-day average (§4.1.1).
- §3.2 earnings momentum (SUE) and §3.3 value (book-to-price): read the stock's quarterly EPS and book value per share (web_fetch the fundamentals_url) and call score_fundamentals. Favour SUE above about 1. Avoid deeply negative SUE and companies with weak balance sheets, high pledging or governance issues.
- Entry timing: the trend should be intact (above the 200-day average, §3.11; MA(10) above MA(30), §3.12; ideally MA(3) > MA(10) > MA(21), §3.13). The best entries are pullbacks: a negative 5-day return against its sector (§3.9.1), a price near the lower part of the 20-day channel (§3.15) or above the daily or weekly pivot after a dip (§3.14), or a low IBS (§4.4). Avoid buying right at the channel ceiling with RSI above about 75. The KNN forecast (§3.17) is weak evidence: use it only when its validation hit rate clearly beats the up share.
- §3.16 event-driven: a cash takeover offer above the market price is a long candidate; weigh the deal's completion risk.
- Holding and exits: momentum and earnings-momentum effects play out over about 1–6 months. Keep a position while it stays in the top half of the composite, its stop holds and the thesis is intact. Consider selling when its composite percentile falls below about 40, when it closes below its 100-day average with deteriorating news, or after a material negative event. Trail the stop up as it gains.
- The paper's short-selling, options-based and market-making strategies (§3.5, §3.8 shorts, §3.18, §3.19) don't apply here: this book is long-only cash equity.

## Each session
1. Call get_account and run_strategy_scan.
2. Review every ai_managed position: get_stock_snapshot, its current composite percentile and recent news. Sell (sell_stock) if the thesis is broken; trail the stop (update_exit) when it has moved well in your favour. Leave the user's own positions alone.
3. Shortlist 3–5 top-ranked candidates that pass the regime and sector filters and aren't already held. For the best one or two: get_stock_snapshot, web_search for news from the last 7–10 days (results, guidance, orders, management, regulation, block deals) and the sector/macro picture (RBI, budget, global cues, crude, FII/DII flows), then read fundamentals and call score_fundamentals. Skip stocks with results due within 2 trading days, or with fraud, governance or regulatory red flags.
4. Buy at most ${s.maxNewPerRun} new positions, and only clear setups with room within the limits. Doing nothing is a valid outcome.
5. Stop-loss: below a logical support (pivot S, channel floor or swing low), usually 1.5–2.5× ATR below the entry; it must be 2–15% below. Target: a resistance (pivot R, channel ceiling, prior high) or measured move worth at least 1.5×, ideally 2×, the risk.
6. Call buy_stock with a concise thesis (2–4 sentences) naming the decisive signals with section numbers, the fundamentals and the news. The app sizes the position; if it rejects a trade, read the reason and move on.
7. End with finish: your market view in one or two sentences, and a short summary of what you did and why.

## Rules
- NSE cash stocks and ETFs only: no F&O, no intraday, no short selling, no penny stocks.
- Use only facts from tools and searches in this session. Never invent numbers; if data is missing, say so and skip the trade. If a fundamentals page can't be fetched, search for the figures on another reputable source or skip SUE for that stock and say so.
- Budget: about ${s.maxSearches} web searches and a few page fetches this session. The app requires at least ₹${s.minLiquidityCr} Cr of average daily traded value.
- The app enforces: largest position ${s.maxPositionPct}% of account value; a loss of at most ${s.riskPerTradePct}% of account value if a stop is hit; at most ${s.maxPositions} AI positions; ${s.cashReservePct}% of the account kept in cash; new buys pause if the account falls ${s.maxDrawdownPct}% below its starting capital.
- Keep your replies short. The user reads your thesis and summary in the app.${
    s.guidance.trim()
      ? `

## The user's instructions
${s.guidance.trim()}`
      : ''
  }`;
}

export function buildUserPrompt(trigger: RunTrigger, slot: number | null, previous: AiRun | null): string {
  const kind =
    slot !== null && slot >= 12 * 60 ? 'afternoon review' : slot !== null ? 'morning session' : trigger === 'manual' ? 'on-demand session' : 'session';
  let text = `Run your ${kind} now.`;
  if (previous && (previous.summary || previous.watchNext.length)) {
    text += `\n\nYour previous session (${formatDayKey(previous.day)} ${formatIstTime(previous.startedAt, false)}) concluded: ${previous.summary ?? '—'}`;
    if (previous.watchNext.length) text += `\nYou planned to revisit: ${previous.watchNext.join(', ')}.`;
  }
  return text;
}

export interface RunOptions {
  apiKey: string;
  settings: AiSettings;
  env: AgentEnv;
  trigger: RunTrigger;
  slot: number | null;
  previous: AiRun | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onUpdate?: (run: AiRun) => void;
  /** Overrides for runs other than the scheduled research session (e.g. live decisions). */
  mode?: AgentMode;
}

export interface AgentMode {
  model: ModelId;
  system: string;
  user: string;
  /** Client tool definitions offered to Claude (server tools are added from the limits below). */
  clientTools: readonly unknown[];
  makeExecutor: (addStep: (step: AiStep) => void) => SessionTools;
  maxRequests: number;
  maxTokens: number;
  maxSearches: number;
  maxFetches: number;
  costCapUsd: number;
}

export async function runAgent(o: RunOptions): Promise<AiRun> {
  const now = o.env.now();
  const wanted = o.mode?.model ?? o.settings.model;
  const model: ModelId = wanted in MODELS ? wanted : 'claude-sonnet-5-5';
  const maxRequests = o.mode?.maxRequests ?? MAX_REQUESTS;
  const maxTokens = o.mode?.maxTokens ?? MAX_TOKENS;
  const costCap = o.mode?.costCapUsd ?? o.settings.perRunCapUsd;
  const searches = o.mode?.maxSearches ?? Math.max(1, Math.round(o.settings.maxSearches));
  const fetches = o.mode?.maxFetches ?? Math.max(2, Math.ceil(o.settings.maxSearches / 2));
  const run: AiRun = {
    id: newId('R'),
    trigger: o.trigger,
    slot: o.slot,
    day: istDayKey(now),
    startedAt: now,
    finishedAt: null,
    status: 'running',
    model,
    marketView: null,
    summary: null,
    watchNext: [],
    steps: [],
    decisions: [],
    usage: { ...EMPTY_USAGE },
    error: null,
  };
  const publish = () => o.onUpdate?.({ ...run, steps: [...run.steps], decisions: [...run.decisions], usage: { ...run.usage } });
  const addStep = (step: AiStep) => {
    run.steps.push({ ...step, text: step.text.slice(0, 300) });
    if (run.steps.length > MAX_STEPS) run.steps.splice(0, run.steps.length - MAX_STEPS);
    publish();
  };

  const tools = o.mode ? o.mode.makeExecutor(addStep) : new SessionTools(o.env, o.settings, addStep);
  const clientTools = (o.mode?.clientTools ?? CLIENT_TOOLS) as readonly { name: string }[];
  const clientNames = new Set(clientTools.map((t) => t.name));
  const toolDefs = [
    ...(searches > 0
      ? [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: searches,
            user_location: { type: 'approximate', country: 'IN', timezone: 'Asia/Kolkata' },
          },
        ]
      : []),
    ...(fetches > 0 ? [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: fetches, max_content_tokens: 12_000 }] : []),
    ...clientTools,
  ] as unknown as ContentBlock[];
  const system: ContentBlock[] = [
    {
      type: 'text',
      text: o.mode?.system ?? buildSystemPrompt(o.settings, now, o.env.marketStatus()),
      cache_control: { type: 'ephemeral' },
    },
  ];
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: o.mode?.user ?? buildUserPrompt(o.trigger, o.slot, o.previous) }] },
  ];
  addStep({ t: now, kind: 'note', text: `Started with ${MODELS[model].label}` });

  let finalText = '';
  try {
    for (let i = 0; i < maxRequests; i++) {
      if (o.signal?.aborted) {
        run.status = 'stopped';
        addStep({ t: o.env.now(), kind: 'note', text: 'Stopped by you' });
        break;
      }
      let res;
      try {
        res = await createMessage(
          { model, max_tokens: maxTokens, system, tools: toolDefs, messages },
          { apiKey: o.apiKey, fetchImpl: o.fetchImpl, signal: o.signal },
        );
      } catch (e) {
        // A server tool the account can't use (e.g. web search disabled by the org admin) fails the
        // first request with a 400. Drop that tool once and continue without it.
        const dropped = i === 0 && e instanceof ClaudeError && e.status === 400 ? droppableTool(e.message, toolDefs) : null;
        if (!dropped) throw e;
        toolDefs.splice(toolDefs.indexOf(dropped), 1);
        addStep({
          t: o.env.now(),
          kind: 'note',
          text: dropped.name === 'web_search' ? 'Web search is unavailable for this API key; continuing without news search' : 'Page reading is unavailable for this API key; continuing without it',
        });
        i--;
        continue;
      }
      const u = res.usage;
      run.usage.requests++;
      run.usage.inputTokens += u.input_tokens ?? 0;
      run.usage.outputTokens += u.output_tokens ?? 0;
      run.usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      run.usage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
      run.usage.searches += u.server_tool_use?.web_search_requests ?? 0;
      run.usage.fetches += u.server_tool_use?.web_fetch_requests ?? 0;
      run.usage.costUsd += costOf(model, u);

      // The assistant turn goes back exactly as received (thinking blocks, search results and all).
      messages.push({ role: 'assistant', content: res.content });

      const results: ContentBlock[] = [];
      for (const block of res.content) {
        if (block.type === 'server_tool_use') {
          if (block.name === 'web_search') addStep({ t: o.env.now(), kind: 'search', text: `Searched: ${String(block.input?.query ?? '')}` });
          else if (block.name === 'web_fetch') addStep({ t: o.env.now(), kind: 'fetch', text: `Read: ${String(block.input?.url ?? '')}` });
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          finalText = block.text.trim();
        } else if (block.type === 'tool_use' && res.stop_reason === 'tool_use') {
          const name = String(block.name);
          const out = clientNames.has(name)
            ? await tools.execute(name, (block.input ?? {}) as Record<string, unknown>)
            : { content: JSON.stringify({ error: `Unknown tool ${name}` }), isError: true };
          results.push({ type: 'tool_result', tool_use_id: block.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
        }
      }
      publish();

      if (res.stop_reason === 'pause_turn') continue;
      if (res.stop_reason === 'tool_use') {
        if (tools.finished) break;
        if (run.usage.costUsd >= costCap) {
          addStep({ t: o.env.now(), kind: 'note', text: `Stopped at the $${costCap.toFixed(2)} per-run cost cap` });
          break;
        }
        messages.push({ role: 'user', content: results });
        continue;
      }
      if (res.stop_reason === 'max_tokens') addStep({ t: o.env.now(), kind: 'note', text: 'Claude hit the response length limit' });
      if (res.stop_reason === 'refusal') addStep({ t: o.env.now(), kind: 'note', text: 'Claude declined to continue' });
      break;
    }
    if (run.status === 'running') run.status = 'completed';
  } catch (e) {
    if (e instanceof ClaudeError && e.kind === 'aborted') {
      run.status = 'stopped';
      addStep({ t: o.env.now(), kind: 'note', text: 'Stopped by you' });
    } else {
      run.status = 'failed';
      run.error = e instanceof Error ? e.message : 'Run failed';
      addStep({ t: o.env.now(), kind: 'error', text: run.error });
    }
  }

  run.decisions = tools.decisions;
  if (tools.finished) {
    run.marketView = tools.finished.marketView || null;
    run.summary = tools.finished.summary || null;
    run.watchNext = tools.finished.watchNext;
  } else if (finalText) {
    run.summary = finalText.slice(0, 2000);
  }
  run.finishedAt = o.env.now();
  run.usage.costUsd = Math.round(run.usage.costUsd * 10000) / 10000;
  publish();
  return run;
}

function droppableTool(message: string, tools: ContentBlock[]): ContentBlock | null {
  const m = message.toLowerCase();
  for (const name of ['web_fetch', 'web_search']) {
    if (m.includes(name) || m.includes(name.replace('_', ' '))) {
      const t = tools.find((x) => x.name === name);
      if (t) return t;
    }
  }
  return null;
}
