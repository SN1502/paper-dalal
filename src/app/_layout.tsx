import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { bootstrap } from '@/state/bootstrap';
import { engineStore } from '@/state/engineStore';
import { Txt } from '@/ui/kit';
import { usePalette, useIsDark } from '@/ui/theme';
import { ToastHost } from '@/ui/ToastHost';

export default function RootLayout() {
  const p = usePalette();
  const dark = useIsDark();
  const [ready, setReady] = useState(engineStore.isReady());
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    bootstrap()
      .then(() => alive && setReady(true))
      .catch((e) => alive && setFailed(e instanceof Error ? e.message : 'Could not start'));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    SystemUI.setBackgroundColorAsync(p.bg).catch(() => undefined);
  }, [p.bg]);

  return (
    <SafeAreaProvider>
      <StatusBar style={dark ? 'light' : 'dark'} />
      {ready ? (
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: p.bg },
            animation: 'slide_from_right',
          }}
        >
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="stock/[symbol]" />
          <Stack.Screen name="search" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
          <Stack.Screen name="order" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
        </Stack>
      ) : (
        <View style={{ flex: 1, backgroundColor: p.bg, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 }}>
          {failed ? (
            <Txt v="body" c="down" align="center">
              PaperDalal couldn’t load your saved account: {failed}
            </Txt>
          ) : (
            <ActivityIndicator color={p.accent} />
          )}
        </View>
      )}
      <ToastHost />
    </SafeAreaProvider>
  );
}
