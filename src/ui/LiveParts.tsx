import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import type { NewsItem } from '../live/news';
import { useLive, type LiveEvent, type LivePhase } from '../live/store';
import { formatIstTime } from '../lib/time';
import { Pill, Txt, type PillTone } from './kit';
import { radius, space, usePalette } from './theme';

export const PHASE: Record<LivePhase, [string, PillTone]> = {
  off: ['Off', 'neutral'],
  waiting: ['Waiting', 'neutral'],
  starting: ['Starting', 'accent'],
  watching: ['Watching', 'up'],
  thinking: ['Thinking', 'accent'],
  paused: ['Paused', 'warn'],
};

/** Small "LIVE" badge for headers while Live mode is on. */
export function LiveBadge() {
  const live = useLive();
  const router = useRouter();
  const p = usePalette();
  if (!live.armed) return null;
  const active = live.phase === 'watching' || live.phase === 'thinking' || live.phase === 'starting';
  return (
    <Pressable onPress={() => router.push('/ai/live')} accessibilityRole="button" accessibilityLabel={`Live trading: ${live.phaseText}`} hitSlop={6}>
      <View style={[styles.badge, { borderColor: active ? p.accent : p.border, backgroundColor: active ? p.accentSoft : p.surface }]}>
        <View style={[styles.dot, { backgroundColor: active ? p.accent : p.faint }]} />
        <Txt v="smallStrong" c={active ? 'accent' : 'muted'}>
          {live.phase === 'thinking' ? 'AI' : 'LIVE'}
        </Txt>
      </View>
    </Pressable>
  );
}

const sym = (s: string | null) => (s ? s.replace(/\.NS$/, '') : 'Market');

export function EventRow({ e }: { e: LiveEvent }) {
  const p = usePalette();
  const router = useRouter();
  const color = e.priority >= 3 ? p.down : e.priority === 2 ? p.accent : p.faint;
  const icon = e.kind === 'signal' ? (e.direction === 'short' ? 'trending-down' : 'trending-up') : e.kind === 'macro' ? 'globe-outline' : 'newspaper-outline';
  const open = () => {
    if (e.symbol) router.push({ pathname: '/stock/[symbol]', params: { symbol: e.symbol } });
    else if (e.link) void Linking.openURL(e.link).catch(() => undefined);
  };
  return (
    <Pressable onPress={open} style={({ pressed }) => [styles.row, pressed && { backgroundColor: p.surfaceAlt }]} accessibilityRole="button">
      <Ionicons name={icon} size={18} color={color} style={{ marginTop: 2 }} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={styles.line}>
          <Txt v="smallStrong">{sym(e.symbol)}</Txt>
          <Txt v="small" c="muted" style={{ flex: 1 }} numberOfLines={1}>
            {e.kind === 'signal' ? e.title : e.kind === 'macro' ? 'Market news' : 'News'}
          </Txt>
          <Txt v="small" c="faint" num>
            {formatIstTime(e.t, false)}
          </Txt>
        </View>
        <Txt v="small" numberOfLines={3}>
          {e.kind === 'signal' ? e.detail : e.title}
        </Txt>
        <Txt v="small" c="faint">
          {e.runId ? 'Seen by the AI' : e.priority >= 2 ? 'Waiting for the AI' : 'For the next check-in'}
        </Txt>
      </View>
    </Pressable>
  );
}

export function NewsRow({ n }: { n: NewsItem }) {
  const p = usePalette();
  return (
    <Pressable
      onPress={() => (n.link ? void Linking.openURL(n.link).catch(() => undefined) : undefined)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: p.surfaceAlt }]}
      accessibilityRole="link"
    >
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={styles.line}>
          <Pill label={n.source === 'nse' ? 'NSE filing' : 'Pulse'} tone={n.source === 'nse' ? 'accent' : 'neutral'} />
          {n.macro ? <Pill label="Market" tone="warn" /> : null}
          {n.symbols.slice(0, 3).map((s) => (
            <Pill key={s} label={s.replace(/\.NS$/, '')} tone={n.important ? 'up' : 'neutral'} />
          ))}
          <View style={{ flex: 1 }} />
          <Txt v="small" c="faint" num>
            {formatIstTime(n.publishedAt, false)}
          </Txt>
        </View>
        <Txt v="small" numberOfLines={3}>
          {n.title}
        </Txt>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  row: { flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, alignItems: 'flex-start' },
  line: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
});
