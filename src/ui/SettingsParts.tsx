import { Switch, View } from 'react-native';

import { Segmented, Txt } from './kit';
import { space, usePalette } from './theme';

export type Opt<T extends string> = { value: T; label: string };

export function Choice<T extends string>({ label, help, options, value, onChange }: { label: string; help?: string; options: Opt<T>[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={{ gap: space.sm }}>
      <View>
        <Txt v="bodyStrong">{label}</Txt>
        {help ? (
          <Txt v="small" c="muted">
            {help}
          </Txt>
        ) : null}
      </View>
      <Segmented options={options} value={value} onChange={onChange} size="sm" />
    </View>
  );
}

export function Toggle({ label, help, value, onChange }: { label: string; help: string; value: boolean; onChange: (v: boolean) => void }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt v="bodyStrong">{label}</Txt>
        <Txt v="small" c="muted">
          {help}
        </Txt>
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: p.accent, false: p.border }} thumbColor={p.surface} accessibilityLabel={label} />
    </View>
  );
}
