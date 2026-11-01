import { reloadAppAsync } from 'expo';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, Txt } from './kit';
import { radius, space, usePalette } from './theme';

/** Shown instead of closing the app when something fails. */
export function CrashScreen({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const p = usePalette();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }}>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        <Txt v="title">Something went wrong</Txt>
        <Txt v="body" c="muted">
          PaperDalal hit an error. Your paper account is saved on this phone. Try again, and if it keeps happening, send a
          screenshot of this screen to the developer.
        </Txt>
        <View style={[styles.box, { backgroundColor: p.surface, borderColor: p.border }]}>
          <Text selectable style={[styles.mono, { color: p.down }]}>
            {error.message || String(error)}
          </Text>
          {error.stack ? (
            <Text selectable style={[styles.mono, { color: p.muted, marginTop: space.sm }]} numberOfLines={30}>
              {error.stack}
            </Text>
          ) : null}
        </View>
        {onRetry ? <Button label="Try again" onPress={onRetry} /> : null}
        <Button label="Restart the app" variant="secondary" onPress={() => void reloadAppAsync('PaperDalal error screen').catch(() => undefined)} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space.md },
  mono: { fontFamily: 'monospace', fontSize: 12, lineHeight: 17 },
});
