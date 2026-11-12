import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { MODELS } from '@/ai/claude';
import { useAi } from '@/ai/store';
import type { AiRun } from '@/ai/types';
import { signedRupees, rupees } from '@/lib/format';
import { liveTrader } from '@/live/liveTrader';
import { aiIntradayStats } from '@/live/stats';
import { spendOn, useLive } from '@/live/store';
import { formatIstTime, istDayKey } from '@/lib/time';
import { useEngine } from '@/state/engineStore';
import { useQuotes } from '@/state/quoteStore';
import { DecisionRow, whenLabel } from '@/ui/AiParts';
import { Button, Card, Divider, Empty, IconButton, Pill, Screen, Segmented, Stat, TopBar, Txt } from '@/ui/kit';
import { EventRow, NewsRow, PHASE } from '@/ui/LiveParts';
import { useNav } from '@/ui/nav';
import { radius, space, toneOf, usePalette } from '@/ui/theme';

type Tab = 'events' | 'decisions' | 'news';

function LiveRunCard({ run }: { run: AiRun }) {
  const router = useRouter();
  return (
    <Pressable onPress={() => router.push({ pathname: '/ai/run/[id]', params: { id: run.id } })} style={{ paddingHorizontal: space.lg, paddingVertical: space.md, gap: 4 }}>
      <View style={styles.row}>
        <Txt v="smallStrong" style={{ flex: 1 }}>
          {whenLabel(run.startedAt)}
        </Txt>
        {run.status !== 'completed' ? <Pill label={run.status} tone={run.status === 'failed' ? 'down' : run.status === 'running' ? 'accent' : 'warn'} /> : null}
        <Txt v="small" c="faint" num>
          ${run.usage.costUsd.toFixed(3)}
        </Txt>
      </View>
      <Txt v="small" c={run.error ? 'down' : 'muted'} numberOfLines={3}>
        {run.summary ?? run.error ?? (run.status === 'running' ? 'Deciding…' : 'No summary')}
      </Txt>
      {run.decisions.map((d, i) => (
        <DecisionRow key={`${run.id}-${i}`} d={d} />
      ))}
    </Pressable>
  );
}

export default function LiveScreen() {
  const p = usePalette();
  const router = useRouter();
  const nav = useNav();
  const live = useLive();
  const ai = useAi();
  const state = useEngine();
  const quotes = useQuotes();
  const [tab, setTab] = useState<Tab>('events');
  const [message, setMessage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const today = istDayKey(now);
  const stats = useMemo(() => aiIntradayStats(state, quotes, live.runs, now), [state, quotes, live.runs, now]);
  const spent = spendOn(live, today);
  const budget = live.settings.dailyBudgetUsd;
  const [phaseLabel, phaseTone] = PHASE[live.phase];
  const lastStep = live.thinking?.steps[live.thinking.steps.length - 1];
  const todayRuns = live.runs.filter((r) => r.day === today);
  const events = live.events.slice(0, 120);
  const news = live.news.slice(0, 100);

  const start = async () => {
    setMessage(null);
    setStarting(true);
    const err = await liveTrader.arm();
    setStarting(false);
    if (err) setMessage(err);
  };

  const decideNow = () => {
    setMessage(null);
    const err = liveTrader.requestDecision();
    if (err) setMessage(err);
  };

  const feedLine = (['pulse', 'nse'] as const)
    .filter((k) => (k === 'pulse' ? live.settings.newsPulse : live.settings.newsNse))
    .map((k) => {
      const f = live.feeds[k];
      const name = k === 'pulse' ? 'Pulse' : 'NSE';
      if (f.lastError) return `${name}: ${f.lastError}`;
      if (f.lastOkAt) return `${name} ${formatIstTime(f.lastOkAt, false)}`;
      return `${name}: waiting`;
    })
    .join(' · ');

  return (
    <Screen>
      <TopBar
        back
        title="Live trading"
        subtitle={live.armed ? live.phaseText : 'Intraday + swing, decided by Claude as the market moves'}
        right={<IconButton name="options-outline" label="Live settings" onPress={() => router.push('/ai/live-settings')} />}
      />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md }}>
        <Card style={{ gap: space.md }}>
          <View style={styles.row}>
            <Pill label={live.armed ? phaseLabel : 'Off'} tone={live.armed ? phaseTone : 'neutral'} />
            <View style={{ flex: 1 }} />
            <Txt v="small" c="faint">
              {MODELS[live.settings.model]?.label ?? live.settings.model}
            </Txt>
          </View>

          {!ai.hasKey ? (
            <>
              <Txt v="body">Live mode uses your Claude API key. Add it first.</Txt>
              <Button label="Add API key" icon="key-outline" onPress={() => router.push('/ai/settings')} />
            </>
          ) : !live.armed ? (
            <>
              <Txt v="body">
                While this app is open in market hours, Live mode watches about 40 stocks minute by minute: opening-range and
                channel breakouts, pivot levels (§3.14), moving-average crosses (§3.12), volume spikes and news from Zerodha Pulse
                and NSE filings. Claude looks at what happened and can take intraday longs or shorts with a stop-loss and target,
                manage them, or add a swing position.
              </Txt>
              <Txt v="small" c="muted">
                Keep the app open and the phone charging; the screen stays on during market hours. Trading stops when the app is
                closed or in the background.
              </Txt>
              <Button label="Start Live mode" icon="pulse-outline" loading={starting} onPress={start} />
            </>
          ) : (
            <>
              {live.thinking ? (
                <View style={styles.row}>
                  <ActivityIndicator color={p.accent} />
                  <Txt v="body" style={{ flex: 1 }} numberOfLines={2}>
                    {lastStep?.text ?? live.phaseText}
                  </Txt>
                </View>
              ) : (
                <Txt v="body">{live.phaseText}</Txt>
              )}
              <Txt v="small" c="muted" num>
                Watching {live.watching} stocks
                {live.nextCheckInAt && !live.thinking ? ` · next check-in ${formatIstTime(Math.max(live.nextCheckInAt, now), false)}` : ''}
                {live.lastDecisionAt ? ` · last decision ${whenLabel(live.lastDecisionAt)}` : ''}
              </Txt>
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                {live.thinking ? (
                  <Button label="Cancel decision" variant="secondary" style={{ flex: 1 }} onPress={() => liveTrader.stopThinking()} />
                ) : (
                  <Button label="Decide now" variant="secondary" icon="flash-outline" style={{ flex: 1 }} onPress={decideNow} />
                )}
                <Button label="Stop Live" variant="danger" style={{ flex: 1 }} onPress={() => liveTrader.disarm()} />
              </View>
            </>
          )}
          {message ? (
            <Txt v="small" c="down">
              {message}
            </Txt>
          ) : null}
        </Card>

        <Card style={{ gap: space.md }}>
          <Txt v="caption" c="muted">
            Today · AI intraday
          </Txt>
          <View style={styles.statRow}>
            <Stat label="P&L (before charges)" value={signedRupees(stats.pnlToday)} tone={toneOf(p, stats.pnlToday)} />
            <Stat label="Trades" value={`${stats.tradesToday} of ${live.settings.maxTradesPerDay}`} align="right" />
          </View>
          {stats.positions.length ? <Divider /> : null}
          {stats.positions.map((pos) => (
            <Pressable key={pos.symbol} onPress={() => nav.stock(pos.symbol)} style={styles.row} accessibilityRole="button">
              <Pill label={pos.direction === 'long' ? 'Long' : 'Short'} tone={pos.direction === 'long' ? 'buy' : 'sell'} />
              <Txt v="bodyStrong">{pos.tradingSymbol}</Txt>
              <Txt v="small" c="muted" num style={{ flex: 1 }}>
                {pos.qty} @ {rupees(pos.avgPrice)}
              </Txt>
              <Txt v="smallStrong" num c={toneOf(p, pos.pnl)}>
                {signedRupees(pos.pnl)}
              </Txt>
            </Pressable>
          ))}
          <Divider />
          <View style={styles.row}>
            <Txt v="small" c="muted" style={{ flex: 1 }}>
              Live AI spend today (estimate)
            </Txt>
            <Txt v="smallStrong" num c={spent >= budget ? p.down : undefined}>
              ${spent.toFixed(2)} of ${budget.toFixed(2)}
            </Txt>
          </View>
          <View style={[styles.meter, { backgroundColor: p.surfaceAlt }]}>
            <View
              style={{
                width: `${Math.min(100, (spent / Math.max(0.01, budget)) * 100)}%`,
                height: '100%',
                backgroundColor: spent >= budget ? p.down : p.accent,
                borderRadius: radius.pill,
              }}
            />
          </View>
          <Txt v="small" c="faint">
            {todayRuns.length} decision{todayRuns.length === 1 ? '' : 's'} today · intraday positions square off at {state.settings.squareOffTime}
          </Txt>
        </Card>

        <Segmented<Tab>
          options={[
            { value: 'events', label: `Events${events.length ? ` (${events.length})` : ''}` },
            { value: 'decisions', label: 'Decisions' },
            { value: 'news', label: 'News' },
          ]}
          value={tab}
          onChange={setTab}
        />

        <Card padded={false}>
          {tab === 'events' ? (
            events.length ? (
              events.map((e, i) => (
                <View key={e.id}>
                  {i > 0 ? <Divider inset={space.lg} /> : null}
                  <EventRow e={e} />
                </View>
              ))
            ) : (
              <Empty icon="pulse-outline" title="No events yet" body="Signals and news on the stocks being watched appear here during market hours." />
            )
          ) : tab === 'decisions' ? (
            live.runs.length ? (
              live.runs.slice(0, 60).map((r, i) => (
                <View key={r.id}>
                  {i > 0 ? <Divider inset={space.lg} /> : null}
                  <LiveRunCard run={live.thinking?.id === r.id ? live.thinking : r} />
                </View>
              ))
            ) : (
              <Empty icon="sparkles-outline" title="No live decisions yet" body="Claude is called when an important event happens and for a check-in every half hour." />
            )
          ) : news.length ? (
            news.map((n, i) => (
              <View key={n.id}>
                {i > 0 ? <Divider inset={space.lg} /> : null}
                <NewsRow n={n} />
              </View>
            ))
          ) : (
            <Empty icon="newspaper-outline" title="No news yet" body="Headlines from Zerodha Pulse and NSE filings appear once Live mode is on." />
          )}
        </Card>

        {live.armed && feedLine ? (
          <Txt v="small" c="faint" style={{ paddingHorizontal: space.xs }}>
            News feeds: {feedLine}
          </Txt>
        ) : null}

        <View style={[styles.row, { paddingHorizontal: space.xs, alignItems: 'flex-start' }]}>
          <Ionicons name="information-circle-outline" size={16} color={p.faint} style={{ marginTop: 2 }} />
          <Txt v="small" c="faint" style={{ flex: 1 }}>
            Paper trades only. Prices are Yahoo Finance snapshots refreshed every few seconds, not exchange ticks, and can lag.
            Intraday stop-losses and targets are checked on each refresh, so fills can be worse than the level in fast markets.
            Signals and AI decisions can be wrong; API costs are estimates billed to your Anthropic account.
          </Txt>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  meter: { height: 6, borderRadius: radius.pill, overflow: 'hidden' },
});
