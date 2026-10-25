import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { formatAge } from '../lib/time';
import { useMarketStatus, type MarketStatus } from '../state/controller';
import { useFeedStatus } from '../state/uiStores';
import { Pill, Txt, type PillTone } from './kit';
import { space, usePalette } from './theme';

const LABEL: Record<MarketStatus, [string, PillTone]> = {
  open: ['Market open', 'up'],
  'pre-open': ['Pre-open', 'warn'],
  closed: ['Market closed', 'neutral'],
  weekend: ['Weekend', 'neutral'],
  holiday: ['Market holiday', 'warn'],
};

export function MarketPill() {
  const status = useMarketStatus();
  const [label, tone] = LABEL[status];
  return <Pill label={label} tone={tone} />;
}

/** "Live · Yahoo · 3s ago" with a status dot. */
export function FeedLine() {
  const p = usePalette();
  const feed = useFeedStatus();
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 5000);
    return () => clearInterval(id);
  }, []);
  const ok = feed.lastSuccessAt > 0 && Date.now() - feed.lastSuccessAt < 2 * 60_000;
  const color = feed.refreshing ? p.accent : ok ? p.up : feed.lastError ? p.down : p.faint;
  const source = feed.source === 'google' ? 'Google Finance (fallback)' : feed.source === 'yahoo' ? 'Yahoo Finance' : 'Connecting';
  const text = feed.lastSuccessAt
    ? `${source} · updated ${formatAge(feed.lastSuccessAt)} ago`
    : feed.lastError
      ? `Prices unavailable · ${feed.lastError}`
      : 'Connecting to price feed…';
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Txt v="small" c="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
        {text}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  dot: { width: 7, height: 7, borderRadius: 4 },
});
