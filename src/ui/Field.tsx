import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Txt } from './kit';
import { radius, space, typeScale, usePalette } from './theme';

export function NumberField({
  id,
  label,
  value,
  onChangeText,
  onStep,
  prefix,
  hint,
  invalid,
  disabled,
  integer,
}: {
  id: string;
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  onStep?: (dir: 1 | -1) => void;
  prefix?: string;
  hint?: string;
  invalid?: boolean;
  disabled?: boolean;
  integer?: boolean;
}) {
  const p = usePalette();
  return (
    <View style={{ flex: 1, gap: 6, minWidth: 0 }}>
      <Txt v="caption" c="muted" nativeID={`${id}-label`}>
        {label}
      </Txt>
      <View
        style={[
          styles.box,
          {
            borderColor: invalid ? p.down : p.border,
            backgroundColor: disabled ? p.surfaceAlt : p.surface,
          },
        ]}
      >
        {onStep && !disabled ? (
          <Pressable onPress={() => onStep(-1)} hitSlop={6} accessibilityLabel={`Decrease ${label}`} style={styles.step}>
            <Ionicons name="remove" size={18} color={p.muted} />
          </Pressable>
        ) : null}
        {prefix ? (
          <Txt v="body" c="muted">
            {prefix}
          </Txt>
        ) : null}
        <TextInput
          testID={id}
          accessibilityLabelledBy={`${id}-label`}
          accessibilityLabel={label}
          value={value}
          onChangeText={(t) => onChangeText(integer ? t.replace(/[^0-9]/g, '') : t.replace(/[^0-9.]/g, ''))}
          keyboardType={integer ? 'number-pad' : 'decimal-pad'}
          editable={!disabled}
          selectTextOnFocus
          style={[typeScale.heading, styles.input, { color: disabled ? p.muted : p.text }]}
          placeholderTextColor={p.faint}
          placeholder="0"
          maxFontSizeMultiplier={1.3}
        />
        {onStep && !disabled ? (
          <Pressable onPress={() => onStep(1)} hitSlop={6} accessibilityLabel={`Increase ${label}`} style={styles.step}>
            <Ionicons name="add" size={18} color={p.muted} />
          </Pressable>
        ) : null}
      </View>
      {hint ? (
        <Txt v="small" c={invalid ? 'down' : 'faint'} numberOfLines={2}>
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.sm,
    minHeight: 50,
    gap: 2,
  },
  input: { flex: 1, minWidth: 0, paddingVertical: 10, paddingHorizontal: 4, fontVariant: ['tabular-nums'], textAlign: 'center' },
  step: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
});
