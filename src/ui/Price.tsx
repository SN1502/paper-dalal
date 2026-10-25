import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, View } from 'react-native';

import { num, pct, signedNum } from '../lib/format';
import { Txt } from './kit';
import { radius, toneOf, usePalette, type TypeVariant } from './theme';

/** Last price that briefly flashes green or red when it ticks. */
export function LivePrice({ value, v = 'bodyStrong', align = 'right' }: { value: number | null | undefined; v?: TypeVariant; align?: 'left' | 'right' }) {
  const p = usePalette();
  const prev = useRef<number | null | undefined>(value);
  const flash = useRef(new Animated.Value(0)).current;
  const dir = useRef<1 | -1>(1);
  const reduceMotion = useRef(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .then((r) => {
        reduceMotion.current = r;
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (before === null || before === undefined || value === null || value === undefined || before === value) return;
    if (reduceMotion.current) return;
    dir.current = value > before ? 1 : -1;
    flash.setValue(1);
    Animated.timing(flash, { toValue: 0, duration: 900, useNativeDriver: false }).start();
  }, [value, flash]);

  const bg = flash.interpolate({
    inputRange: [0, 1],
    outputRange: ['rgba(0,0,0,0)', dir.current === 1 ? p.flashUp : p.flashDown],
  });

  return (
    <Animated.View style={[styles.flash, { backgroundColor: bg, alignSelf: align === 'right' ? 'flex-end' : 'flex-start' }]}>
      <Txt v={v} num align={align}>
        {num(value)}
      </Txt>
    </Animated.View>
  );
}

/** "+12.40 (+0.85%)" coloured by direction. */
export function Change({
  change,
  changePct,
  v = 'small',
  align = 'right',
  compact,
}: {
  change: number | null | undefined;
  changePct: number | null | undefined;
  v?: TypeVariant;
  align?: 'left' | 'right';
  compact?: boolean;
}) {
  const p = usePalette();
  const tone = toneOf(p, change ?? changePct);
  if (change === null || change === undefined) {
    return (
      <Txt v={v} c="faint" align={align}>
        —
      </Txt>
    );
  }
  return (
    <View style={{ alignSelf: align === 'right' ? 'flex-end' : 'flex-start' }}>
      <Txt v={v} c={tone} num align={align} numberOfLines={1}>
        {compact ? pct(changePct) : `${signedNum(change)} (${pct(changePct)})`}
      </Txt>
    </View>
  );
}

export function changeOf(ltp: number | null | undefined, prevClose: number | null | undefined) {
  if (ltp === null || ltp === undefined || !prevClose) return { change: null, changePct: null };
  const change = ltp - prevClose;
  return { change, changePct: (change / prevClose) * 100 };
}

/** Where the last price sits between the day's low and high. */
export function DayRange({ low, high, ltp }: { low: number | null; high: number | null; ltp: number | null }) {
  const p = usePalette();
  if (low === null || high === null || ltp === null || high <= low) return null;
  const pos = Math.min(1, Math.max(0, (ltp - low) / (high - low)));
  return (
    <View style={[styles.rangeTrack, { backgroundColor: p.surfaceAlt }]} accessibilityLabel={`Day range ${num(low)} to ${num(high)}`}>
      <View style={[styles.rangeDot, { left: `${pos * 100}%` as `${number}%`, backgroundColor: p.muted }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  flash: { borderRadius: radius.sm, paddingHorizontal: 4, marginHorizontal: -4 },
  rangeTrack: { height: 3, borderRadius: 2, width: 56, marginTop: 6 },
  rangeDot: { position: 'absolute', top: -2, width: 7, height: 7, borderRadius: 4, marginLeft: -3.5 },
});
