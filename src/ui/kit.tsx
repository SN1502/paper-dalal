import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { radius, space, typeScale, usePalette, type Palette, type TypeVariant } from './theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

/* ---------------- Text ---------------- */

type ColorKey = keyof Palette;

export interface TxtProps extends TextProps {
  v?: TypeVariant;
  /** Palette key or a literal colour. */
  c?: ColorKey | (string & {});
  /** Tabular figures for numbers that line up. */
  num?: boolean;
  align?: TextStyle['textAlign'];
}

export function Txt({ v = 'body', c, num, align, style, ...rest }: TxtProps) {
  const p = usePalette();
  const color = c ? ((p as Record<string, string>)[c] ?? c) : p.text;
  return (
    <Text
      {...rest}
      style={[typeScale[v], { color, textAlign: align }, num && styles.num, style]}
      maxFontSizeMultiplier={1.4}
    />
  );
}

/* ---------------- Layout ---------------- */

export function Screen({ children, edges = ['top'], style }: { children: ReactNode; edges?: Edge[]; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  return (
    <SafeAreaView edges={edges} style={[{ flex: 1, backgroundColor: p.bg }, style]}>
      {children}
    </SafeAreaView>
  );
}

export function TopBar({
  title,
  subtitle,
  back,
  right,
  large,
}: {
  title: string;
  subtitle?: string;
  back?: boolean;
  right?: ReactNode;
  large?: boolean;
}) {
  const router = useRouter();
  const p = usePalette();
  return (
    <View style={styles.topBar}>
      {back ? (
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          style={({ pressed }) => [styles.iconBtn, { backgroundColor: pressed ? p.surfaceAlt : 'transparent' }]}
        >
          <Ionicons name="chevron-back" size={24} color={p.text} />
        </Pressable>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt v={large ? 'title' : 'heading'} numberOfLines={1}>
          {title}
        </Txt>
        {subtitle ? (
          <Txt v="small" c="muted" numberOfLines={1}>
            {subtitle}
          </Txt>
        ) : null}
      </View>
      {right}
    </View>
  );
}

export function IconButton({ name, onPress, label, color, size = 22 }: { name: IconName; onPress: () => void; label: string; color?: string; size?: number }) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.iconBtn, { backgroundColor: pressed ? p.surfaceAlt : 'transparent' }]}
    >
      <Ionicons name={name} size={size} color={color ?? p.text} />
    </Pressable>
  );
}

export function Card({ children, style, padded = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  const p = usePalette();
  return (
    <View
      style={[
        { backgroundColor: p.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: p.border },
        padded && { padding: space.lg },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Divider({ inset = 0 }: { inset?: number }) {
  const p = usePalette();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.border, marginLeft: inset }} />;
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <View style={styles.sectionLabel}>
      <Txt v="caption" c="muted">
        {children}
      </Txt>
      {right}
    </View>
  );
}

/** Label above a value, for stat grids. */
export function Stat({ label, value, tone, align = 'left' }: { label: string; value: string; tone?: string; align?: 'left' | 'right' }) {
  return (
    <View style={{ gap: 2, alignItems: align === 'right' ? 'flex-end' : 'flex-start', minWidth: 0 }}>
      <Txt v="caption" c="muted">
        {label}
      </Txt>
      <Txt v="bodyStrong" num c={tone} numberOfLines={1}>
        {value}
      </Txt>
    </View>
  );
}

export function KeyValue({ label, value, tone, strong }: { label: string; value: string; tone?: string; strong?: boolean }) {
  return (
    <View style={styles.kv}>
      <Txt v="small" c="muted" style={{ flexShrink: 1 }}>
        {label}
      </Txt>
      <Txt v={strong ? 'bodyStrong' : 'small'} num c={tone}>
        {value}
      </Txt>
    </View>
  );
}

/* ---------------- Controls ---------------- */

export type PillTone = 'neutral' | 'up' | 'down' | 'buy' | 'sell' | 'warn' | 'accent';

export function Pill({ label, tone = 'neutral', icon }: { label: string; tone?: PillTone; icon?: IconName }) {
  const p = usePalette();
  const map: Record<PillTone, [string, string]> = {
    neutral: [p.surfaceAlt, p.muted],
    up: [p.upSoft, p.up],
    down: [p.downSoft, p.down],
    buy: [p.buySoft, p.buy],
    sell: [p.sellSoft, p.sell],
    warn: [p.warnSoft, p.warn],
    accent: [p.accentSoft, p.accent],
  };
  const [bg, fg] = map[tone];
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      {icon ? <Ionicons name={icon} size={11} color={fg} /> : null}
      <Text style={[styles.pillText, { color: fg }]} maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
    </View>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  activeColor,
  size = 'md',
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  activeColor?: string;
  size?: 'sm' | 'md';
}) {
  const p = usePalette();
  return (
    <View style={[styles.segment, { backgroundColor: p.surfaceAlt }]} accessibilityRole="tablist">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[
              styles.segmentItem,
              size === 'sm' && { paddingVertical: 6 },
              active && { backgroundColor: p.surface, shadowColor: p.shadow, shadowOpacity: 1, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
            ]}
          >
            <Txt v={size === 'sm' ? 'smallStrong' : 'smallStrong'} c={active ? (activeColor ?? p.text) : p.muted} numberOfLines={1}>
              {o.label}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

export type ButtonVariant = 'buy' | 'sell' | 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  icon,
  style,
  compact,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}) {
  const p = usePalette();
  const map: Record<ButtonVariant, { bg: string; fg: string; border?: string }> = {
    buy: { bg: p.buy, fg: p.onAccent },
    sell: { bg: p.sell, fg: p.onAccent },
    primary: { bg: p.accent, fg: p.onAccent },
    secondary: { bg: p.surface, fg: p.text, border: p.border },
    ghost: { bg: 'transparent', fg: p.accent },
    danger: { bg: p.downSoft, fg: p.down },
  };
  const c = map[variant];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        { backgroundColor: c.bg, borderColor: c.border ?? 'transparent', opacity: disabled ? 0.45 : pressed ? 0.85 : 1 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={c.fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={18} color={c.fg} /> : null}
          <Txt v="bodyStrong" c={c.fg} numberOfLines={1}>
            {label}
          </Txt>
        </>
      )}
    </Pressable>
  );
}

export function Empty({ icon, title, body, action }: { icon: IconName; title: string; body: string; action?: ReactNode }) {
  const p = usePalette();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: p.surfaceAlt }]}>
        <Ionicons name={icon} size={26} color={p.muted} />
      </View>
      <Txt v="heading" align="center">
        {title}
      </Txt>
      <Txt v="small" c="muted" align="center" style={{ maxWidth: 300 }}>
        {body}
      </Txt>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  num: { fontVariant: ['tabular-nums'] },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
    minHeight: 52,
  },
  iconBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  sectionLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.sm,
  },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.md, paddingVertical: 6 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.sm,
    alignSelf: 'flex-start',
  },
  pillText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  segment: { flexDirection: 'row', borderRadius: radius.md, padding: 3, gap: 3 },
  segmentItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 6, borderRadius: radius.sm + 1 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    minHeight: 50,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  buttonCompact: { minHeight: 38, paddingHorizontal: space.md },
  empty: { alignItems: 'center', gap: space.sm, paddingVertical: 48, paddingHorizontal: space.xl },
  emptyIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: space.sm },
});
