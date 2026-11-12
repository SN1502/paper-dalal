import { useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { MODELS, type ModelId } from '@/ai/claude';
import { aiRunner } from '@/ai/runner';
import { liveTrader } from '@/live/liveTrader';
import { useAi } from '@/ai/store';
import { useLive } from '@/live/store';
import { formatIstDateTime } from '@/lib/time';
import { DecisionRow, StepRow } from '@/ui/AiParts';
import { Button, Card, Divider, Empty, KeyValue, Pill, Screen, TopBar, Txt } from '@/ui/kit';
import { space } from '@/ui/theme';

export default function RunDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const ai = useAi();
  const live = useLive();
  const run =
    ai.running?.id === id
      ? ai.running
      : live.thinking?.id === id
        ? live.thinking
        : ai.journal.find((r) => r.id === id) ?? live.runs.find((r) => r.id === id);

  if (!run) {
    return (
      <Screen>
        <TopBar back title="AI session" />
        <Empty icon="document-outline" title="Session not found" body="It may have been cleared from the journal." />
      </Screen>
    );
  }

  const minutes = run.finishedAt ? Math.max(1, Math.round((run.finishedAt - run.startedAt) / 60_000)) : null;
  const trigger =
    run.trigger === 'manual' ? 'Run by you' : run.trigger === 'background' ? 'Scheduled (background)' : run.trigger === 'live' ? 'Live decision' : 'Scheduled';

  return (
    <Screen>
      <TopBar back title="AI session" subtitle={`${formatIstDateTime(run.startedAt)} IST · ${trigger}`} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md }}>
        <Card style={{ gap: space.sm }}>
          <View style={styles.row}>
            <Pill
              label={run.status}
              tone={run.status === 'completed' ? 'up' : run.status === 'failed' ? 'down' : run.status === 'running' ? 'accent' : 'warn'}
            />
            <View style={{ flex: 1 }} />
            <Txt v="small" c="faint">
              {MODELS[run.model as ModelId]?.label ?? run.model}
              {minutes ? ` · ${minutes} min` : ''}
            </Txt>
          </View>
          {run.marketView ? <Txt v="bodyStrong">{run.marketView}</Txt> : null}
          {run.summary ? <Txt v="body">{run.summary}</Txt> : null}
          {run.watchNext.length ? (
            <Txt v="small" c="muted">
              Watching next: {run.watchNext.join(', ')}
            </Txt>
          ) : null}
          {run.error ? (
            <Txt v="small" c="down">
              {run.error}
            </Txt>
          ) : null}
          {run.status === 'running' ? <Button label="Stop this session" variant="danger" compact onPress={() => (run.trigger === 'live' ? liveTrader.stopThinking() : aiRunner.stop())} /> : null}
        </Card>

        <Card style={{ gap: space.xs }}>
          <Txt v="caption" c="muted">
            Decisions
          </Txt>
          {run.decisions.length === 0 ? (
            <Txt v="small" c="muted">
              {run.status === 'running' ? 'None yet.' : 'No trades this session.'}
            </Txt>
          ) : (
            run.decisions.map((d, i) => (
              <View key={`${d.symbol}-${i}`}>
                {i > 0 ? <Divider /> : null}
                <DecisionRow d={d} />
              </View>
            ))
          )}
        </Card>

        <Card style={{ gap: space.xs }}>
          <Txt v="caption" c="muted">
            What it did
          </Txt>
          {run.steps.map((s, i) => (
            <StepRow key={`${s.t}-${i}`} step={s} />
          ))}
        </Card>

        <Card>
          <Txt v="caption" c="muted" style={{ marginBottom: space.xs }}>
            Usage (estimate)
          </Txt>
          <KeyValue label="Claude requests" value={String(run.usage.requests)} />
          <KeyValue label="Web searches · pages read" value={`${run.usage.searches} · ${run.usage.fetches}`} />
          <KeyValue label="Input tokens (cached reads)" value={`${run.usage.inputTokens.toLocaleString('en-IN')} (${run.usage.cacheReadTokens.toLocaleString('en-IN')})`} />
          <KeyValue label="Output tokens" value={run.usage.outputTokens.toLocaleString('en-IN')} />
          <KeyValue label="Cost" value={`$${run.usage.costUsd.toFixed(3)}`} strong />
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
