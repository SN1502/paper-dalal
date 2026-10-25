import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Txt, type IconName } from './kit';
import { radius, space, usePalette } from './theme';

export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: p.scrim }]} onPress={onClose} accessibilityLabel="Close" />
        <View style={{ flex: 1 }} pointerEvents="box-none" />
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: p.surface,
              paddingBottom: Math.max(insets.bottom, space.lg),
              paddingLeft: Math.max(insets.left, space.lg),
              paddingRight: Math.max(insets.right, space.lg),
            },
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: p.border }]} />
          {title ? (
            <Txt v="heading" style={{ marginBottom: space.md }}>
              {title}
            </Txt>
          ) : null}
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export interface SheetAction {
  label: string;
  icon: IconName;
  onPress: () => void;
  tone?: 'default' | 'buy' | 'sell' | 'danger';
}

/** A list of actions in a bottom sheet (used for long-press menus). */
export function ActionSheet({ visible, onClose, title, subtitle, actions }: { visible: boolean; onClose: () => void; title: string; subtitle?: string; actions: SheetAction[] }) {
  const p = usePalette();
  const color = (t: SheetAction['tone']) => (t === 'buy' ? p.buy : t === 'sell' ? p.sell : t === 'danger' ? p.down : p.text);
  return (
    <Sheet visible={visible} onClose={onClose}>
      <Txt v="heading">{title}</Txt>
      {subtitle ? (
        <Txt v="small" c="muted" style={{ marginBottom: space.sm }}>
          {subtitle}
        </Txt>
      ) : null}
      <View style={{ marginTop: space.sm }}>
        {actions.map((a) => (
          <Pressable
            key={a.label}
            onPress={() => {
              onClose();
              a.onPress();
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.action, { backgroundColor: pressed ? p.surfaceAlt : 'transparent' }]}
          >
            <Ionicons name={a.icon} size={20} color={color(a.tone)} />
            <Txt v="body" c={color(a.tone)}>
              {a.label}
            </Txt>
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
}

/** In-app confirmation (system alert dialogs are avoided so the flow stays in one place). */
export function ConfirmSheet({
  visible,
  onClose,
  title,
  body,
  confirmLabel,
  onConfirm,
  destructive,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  destructive?: boolean;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <Txt v="body" c="muted" style={{ marginBottom: space.lg }}>
        {body}
      </Txt>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Button label="Keep" variant="secondary" onPress={onClose} style={{ flex: 1 }} />
        <Button
          label={confirmLabel}
          variant={destructive ? 'sell' : 'primary'}
          onPress={() => {
            onClose();
            onConfirm();
          }}
          style={{ flex: 1 }}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingTop: space.sm,
  },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginBottom: space.md },
  action: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 14, paddingHorizontal: space.sm, borderRadius: radius.md },
});
