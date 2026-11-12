// Must be first: turns fatal JS errors into an error screen instead of a closed app.
import { getFatalError, onFatalError } from '@/crashGuard';
// Defines the background AI task at startup, as expo-task-manager requires.
import { syncBackgroundTask } from '@/ai/background';
import { aiRunner } from '@/ai/runner';
import { aiStore } from '@/ai/store';
import { liveTrader } from '@/live/liveTrader';
import { controller } from '@/state/controller';
import { Stack, type ErrorBoundaryProps } from 'expo-router';
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
import { CrashScreen } from '@/ui/CrashScreen';

/** Expo Router shows this when a screen throws while rendering. */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <SafeAreaProvider>
      <CrashScreen error={error} onRetry={() => void retry()} />
    </SafeAreaProvider>
  );
}

export default function RootLayout() {
  const p = usePalette();
  const dark = useIsDark();
  const [ready, setReady] = useState(engineStore.isReady());
  const [failed, setFailed] = useState<string | null>(null);
  const [fatal, setFatal] = useState<Error | null>(getFatalError());

  useEffect(() => onFatalError(setFatal), []);

  useEffect(() => {
    let alive = true;
    bootstrap()
      .then(() => {
        try {
          controller.addAfterCycle(() => void aiRunner.maybeAutoRun('auto'));
          liveTrader.start();
          const ai = aiStore.get();
          void syncBackgroundTask(ai.settings.enabled && ai.hasKey);
        } catch (e) {
          console.error('[PaperDalal] AI setup failed:', e instanceof Error ? e.message : e);
        }
        if (alive) setReady(true);
      })
      .catch((e) => alive && setFailed(e instanceof Error ? e.message : 'Could not start'));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    SystemUI.setBackgroundColorAsync(p.bg).catch(() => undefined);
  }, [p.bg]);

  if (fatal) {
    return (
      <SafeAreaProvider>
        <CrashScreen error={fatal} onRetry={() => setFatal(null)} />
      </SafeAreaProvider>
    );
  }

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
          <Stack.Screen name="ai/settings" />
          <Stack.Screen name="ai/signals" />
          <Stack.Screen name="ai/run/[id]" />
          <Stack.Screen name="ai/live" />
          <Stack.Screen name="ai/live-settings" />
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
