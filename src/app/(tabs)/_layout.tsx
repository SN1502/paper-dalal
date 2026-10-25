import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { StyleSheet } from 'react-native';

import { openOrders } from '@/engine/selectors';
import { useEngine } from '@/state/engineStore';
import { usePalette } from '@/ui/theme';

export default function TabLayout() {
  const p = usePalette();
  const state = useEngine();
  const pending = openOrders(state).length;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: p.accent,
        tabBarInactiveTintColor: p.faint,
        tabBarStyle: { backgroundColor: p.surface, borderTopColor: p.border, borderTopWidth: StyleSheet.hairlineWidth },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        sceneStyle: { backgroundColor: p.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Markets',
          tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? 'pulse' : 'pulse-outline'} size={22} color={color as string} />,
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: 'Orders',
          tabBarBadge: pending > 0 ? pending : undefined,
          tabBarBadgeStyle: { backgroundColor: p.accent, color: p.onAccent, fontSize: 10 },
          tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? 'receipt' : 'receipt-outline'} size={22} color={color as string} />,
        }}
      />
      <Tabs.Screen
        name="portfolio"
        options={{
          title: 'Portfolio',
          tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? 'briefcase' : 'briefcase-outline'} size={22} color={color as string} />,
        }}
      />
      <Tabs.Screen
        name="funds"
        options={{
          title: 'Funds',
          tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? 'wallet' : 'wallet-outline'} size={22} color={color as string} />,
        }}
      />
    </Tabs>
  );
}
