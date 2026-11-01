import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { MODELS } from '@/ai/claude';
import { aiStatus, aiRunner, type AiStatus } from '@/ai/runner';
import { nextRunAt } from '@/ai/schedule';
import { aiPerformance } from '@/ai/selectors';
import { monthSpend, useAi } from '@/ai/store';
import type { AiRun } from '@/ai/types';
import { pct, signedRupees } from '@/lib/format';
import { formatIstDateTime } from '@/lib/time';
import { useEngine } from '@/state/engineStore';
import { useQuotes } from '@/state/quoteStore';
import { strategyStore, useStrategies } from '@/strategies/store';
import { DecisionRow, whenLabel } from '@/ui/AiParts';
import { Button, Card, Divider, IconButton, Pill, Screen, Stat, TopBar, Txt, type PillTone } from '@/ui/kit';
import { radius, space, toneOf, usePalette } from '@/ui/theme';

const STATUS: Record<AiStatus, [string, PillTone]> = {
  'no-key': ['Needs API key', 'warn'],
  off: ['Auto-trading off', 'neutral'],
  running: ['Running', 'accent'],
  'paused-budget': ['Paused: monthly budget reached', 'warn'],
  'paused-drawdown': ['Paused: drawdown limit', 'down'],
  on: ['Auto-trading on', 'up'],
};

const REGIME: Record<string, [string, PillTone]> = {
  'risk-on': ['Risk-on', 'up'],
  mixed: ['Mixed', 'warn'],
  'risk-off': ['Risk-off', 'down'],
};

function RunRow({ run, onPress }: { run: AiRun; onPress: () => void }) {
  const p = usePalette();
  const buys = run.decisions.filter((d) => d.action === 'BUY' && d.outcome !== 'rejected').length;
  const sells = run.decisions.filter((d) => d.action === 'SELL' && d.outcome !== 'rejected').length;
  const tone: PillTone = run.status === 'completed' ? 'neutral' : run.status === 'failed' ? 'down' : run.status === 'running' ? 'accent' : 'warn';
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.runRow, pressed && { backgroundColor: p.surfaceAlt }]}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Txt v="bodyStrong">{whenLabel(run.startedAt)}</Txt>
        <Txt v="small" c="muted" numberOfLines={2}>
          {run.summary ?? run.error ?? (run.status === 'running' ? 'In progress…' : 'No summary')}
        </Txt>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <Pill label={run.status === 'completed' ? `${buys} buy · ${sells} sell` : run.status} tone={tone} />
        <Txt v="small" c="faint" num>
          ${run.usage.costUsd.toFixed(2)}
        </Txt>
      </View>
    </Pressable>
  );
}

export default function AiScreen() {
  const p = usePalette();
  const router = useRouter();
  const ai = useAi();
  const strategies = useStrategies();
  const state = useEngine();
  const quotes = useQuotes();
  const [, tick] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 30_000);
    void strategyStore.ensureFresh();
    return () => clearInterval(id);
  }, []);

  const status = aiStatus();
  const [statusLabel, statusTone] = STATUS[status];
  const perf = useMemo(() => aiPerformance(state, quotes), [state, quotes]);
  const spend = monthSpend(ai.journal, Date.now());
  const latest = ai.running ?? ai.journal[0] ?? null;
  const next = nextRunAt(Date.now(), ai.settings, ai.journal);
  const regime = strategies.scan?.regime ?? null;
  const lastStep = ai.running?.steps[ai.running.steps.length - 1];

  const runNow = async () => {
    setMessage(null);
    const err = await aiRunner.runNow();
    if (err) setMessage(err);
  };

  return (
    <Screen>
      <TopBar
        title="AI Trader"
        large
        right={<IconButton name="settings-outline" label="AI settings" onPress={() => router.push('/ai/settings')} />}
      />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md }}>
        <Card style={{ gap: space.md }}>
          <View style={styles.row}>
            <Pill label={statusLabel} tone={statusTone} />
            <View style={{ flex: 1 }} />
            <Txt v="small" c="faint">
              {MODELS[ai.settings.model]?.label ?? ai.settings.model}
            </Txt>
          </View>
          {status === 'no-key' ? (
            <>
              <Txt v="body">
                Add your Claude API key and the AI will research the market each trading morning using the 151 Trading Strategies
                signals, news and fundamentals, then paper-trade within your limits.
              </Txt>
              <Button label="Add API key" icon="key-outline" onPress={() => router.push('/ai/settings')} />
            </>
          ) : ai.running ? (
            <>
              <View style={styles.row}>
                <ActivityIndicator color={p.accent} />
                <Txt v="body" style={{ flex: 1 }} numberOfLines={2}>
                  {lastStep?.text ?? 'Starting…'}
                </Txt>
              </View>
              <Txt v="small" c="faint" num>
                {ai.running.steps.length} steps · {ai.running.usage.searches} searches · est. ${ai.running.usage.costUsd.toFixed(2)}
              </Txt>
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <Button label="Watch" variant="secondary" style={{ flex: 1 }} onPress={() => router.push({ pathname: '/ai/run/[id]', params: { id: ai.running!.id } })} />
                <Button label="Stop" variant="danger" style={{ flex: 1 }} onPress={() => aiRunner.stop()} />
              </View>
            </>
          ) : (
            <>
              <Txt v="small" c="muted">
                {ai.settings.enabled
                  ? `Next session ${whenLabel(next)} IST (trading days only; needs the app open or background refresh allowed).`
                  : 'Automatic sessions are off. You can still run one now.'}
              </Txt>
              <Button label="Run a session now" icon="sparkles-outline" onPress={runNow} />
            </>
          )}
          {message ? (
            <Txt v="small" c="down">
              {message}
            </Txt>
          ) : null}
        </Card>

        <Card style={{ gap: space.md }}>
          <View style={styles.row}>
            <Txt v="caption" c="muted">
              Market regime · §4.1.2
            </Txt>
            <View style={{ flex: 1 }} />
            {regime ? <Pill label={REGIME[regime.state][0]} tone={REGIME[regime.state][1]} /> : null}
          </View>
          {regime ? (
            <Txt v="small" c="muted" num>
              Nifty 50 {regime.close.toLocaleString('en-IN')} vs 100-day {regime.sma100?.toLocaleString('en-IN') ?? '—'} and 200-day{' '}
              {regime.sma200?.toLocaleString('en-IN') ?? '—'} averages.
              {regime.state === 'risk-off' && ai.settings.regimeFilter ? ' New stock buys are paused; gold ETFs only.' : ''}
            </Txt>
          ) : (
            <Txt v="small" c="muted">
              {strategies.status === 'loading'
                ? `Scanning ${strategies.progress?.done ?? 0} of ${strategies.progress?.total ?? '…'} stocks…`
                : strategies.error ?? 'The strategy scan hasn’t run yet.'}
            </Txt>
          )}
          {strategies.scan ? (
            <View style={{ gap: 6 }}>
              {strategies.scan.sectors.slice(0, 3).map((s) => (
                <View key={s.sector} style={styles.row}>
                  <Txt v="small" c="faint" num style={{ width: 18 }}>
                    {s.rank}
                  </Txt>
                  <Txt v="small" style={{ flex: 1 }}>
                    {s.sector}
                  </Txt>
                  <Txt v="smallStrong" num c={toneOf(p, s.ret6m)}>
                    {pct((s.ret6m ?? 0) * 100)} 6M
                  </Txt>
                </View>
              ))}
            </View>
          ) : null}
          <Button label="Open strategy signals" variant="secondary" icon="analytics-outline" onPress={() => router.push('/ai/signals')} />
        </Card>

        <Card style={{ gap: space.md }}>
          <Txt v="caption" c="muted">
            AI trades
          </Txt>
          <View style={styles.statRow}>
            <Stat label="Open positions" value={String(perf.openPositions)} />
            <Stat label="Open P&L" value={signedRupees(perf.unrealized)} tone={toneOf(p, perf.unrealized)} align="right" />
          </View>
          <View style={styles.statRow}>
            <Stat label="Booked, after charges" value={signedRupees(perf.realizedNet)} tone={toneOf(p, perf.realizedNet)} />
            <Stat label="Closed trades" value={perf.trades ? `${perf.wins} won · ${perf.losses} lost` : '—'} align="right" />
          </View>
          <Divider />
          <View style={styles.row}>
            <Txt v="small" c="muted" style={{ flex: 1 }}>
              API spend this month (estimate)
            </Txt>
            <Txt v="smallStrong" num c={spend >= ai.settings.monthlyBudgetUsd ? p.down : undefined}>
              ${spend.toFixed(2)} of ${ai.settings.monthlyBudgetUsd}
            </Txt>
          </View>
          <View style={[styles.meter, { backgroundColor: p.surfaceAlt }]}>
            <View
              style={{
                width: `${Math.min(100, (spend / Math.max(0.01, ai.settings.monthlyBudgetUsd)) * 100)}%`,
                height: '100%',
                backgroundColor: spend >= ai.settings.monthlyBudgetUsd ? p.down : p.accent,
                borderRadius: radius.pill,
              }}
            />
          </View>
        </Card>

        {latest ? (
          <Card style={{ gap: space.sm }}>
            <View style={styles.row}>
              <Txt v="caption" c="muted" style={{ flex: 1 }}>
                {latest.status === 'running' ? 'Current session' : 'Latest session'} · {formatIstDateTime(latest.startedAt)}
              </Txt>
              <Pressable onPress={() => router.push({ pathname: '/ai/run/[id]', params: { id: latest.id } })} hitSlop={8}>
                <Txt v="smallStrong" c="accent">
                  Details
                </Txt>
              </Pressable>
            </View>
            {latest.marketView ? <Txt v="bodyStrong">{latest.marketView}</Txt> : null}
            {latest.summary ? <Txt v="body">{latest.summary}</Txt> : null}
            {latest.error ? (
              <Txt v="small" c="down">
                {latest.error}
              </Txt>
            ) : null}
            {latest.decisions.length ? <Divider /> : null}
            {latest.decisions.map((d, i) => (
              <DecisionRow key={`${d.symbol}-${i}`} d={d} />
            ))}
          </Card>
        ) : null}

        {ai.journal.length > 1 ? (
          <Card padded={false}>
            <Txt v="caption" c="muted" style={{ padding: space.lg, paddingBottom: space.sm }}>
              Journal
            </Txt>
            {ai.journal.slice(1, 30).map((r, i) => (
              <View key={r.id}>
                {i > 0 ? <Divider inset={space.lg} /> : null}
                <RunRow run={r} onPress={() => router.push({ pathname: '/ai/run/[id]', params: { id: r.id } })} />
              </View>
            ))}
          </Card>
        ) : null}

        <View style={[styles.row, { paddingHorizontal: space.xs }]}>
          <Ionicons name="information-circle-outline" size={16} color={p.faint} />
          <Txt v="small" c="faint" style={{ flex: 1 }}>
            Paper trades only. The AI uses your own Anthropic API key, and costs are estimates. Signals and AI decisions can be wrong.
          </Txt>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  runRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  meter: { height: 6, borderRadius: radius.pill, overflow: 'hidden' },
});
