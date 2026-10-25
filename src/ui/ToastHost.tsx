import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { toastStore, useToasts, type Toast } from '../state/uiStores';
import { Txt, type IconName } from './kit';
import { radius, space, usePalette, type Palette } from './theme';

function look(t: Toast, p: Palette): { icon: IconName; color: string } {
  switch (t.kind) {
    case 'fill':
      return { icon: 'checkmark-circle', color: t.side === 'SELL' ? p.sell : p.buy };
    case 'reject':
      return { icon: 'close-circle', color: p.down };
    case 'trigger':
      return { icon: 'flash', color: p.warn };
    case 'squareoff':
      return { icon: 'timer', color: p.warn };
    case 'cancel':
    case 'expire':
      return { icon: 'remove-circle', color: p.muted };
    default:
      return { icon: 'information-circle', color: p.accent };
  }
}

export function ToastHost() {
  const toasts = useToasts();
  const p = usePalette();
  const insets = useSafeAreaInsets();
  if (toasts.length === 0) return null;
  return (
    <View
      pointerEvents="box-none"
      style={[styles.host, { top: insets.top + space.sm, left: Math.max(insets.left, space.md), right: Math.max(insets.right, space.md) }]}
    >
      {toasts.map((t) => {
        const l = look(t, p);
        return (
          <Pressable
            key={t.id}
            onPress={() => toastStore.dismiss(t.id)}
            accessibilityRole="alert"
            accessibilityHint="Tap to dismiss"
            style={[styles.toast, { backgroundColor: p.surface, borderColor: p.border, shadowColor: p.shadow }]}
          >
            <Ionicons name={l.icon} size={22} color={l.color} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Txt v="bodyStrong" numberOfLines={1}>
                {t.title}
              </Txt>
              <Txt v="small" c="muted" numberOfLines={3}>
                {t.body}
              </Txt>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', gap: space.sm, zIndex: 100 },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});
