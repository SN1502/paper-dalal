import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { INDICES } from '@/data/instruments';
import { accountSummary } from '@/engine/selectors';
import type { Instrument } from '@/engine/types';
import { signedRupees, rupees } from '@/lib/format';
import { controller } from '@/state/controller';
import { useEngine } from '@/state/engineStore';
import { useQuote, useQuotes } from '@/state/quoteStore';
import { Divider, Empty, Screen, Txt } from '@/ui/kit';
import { FeedLine, MarketPill } from '@/ui/MarketPill';
import { useNav } from '@/ui/nav';
import { Change, DayRange, LivePrice, changeOf } from '@/ui/Price';
import { ActionSheet } from '@/ui/Sheet';
import { radius, space, toneOf, usePalette } from '@/ui/theme';

function IndexCard({ inst }: { inst: Instrument }) {
  const p = usePalette();
  const q = useQuote(inst.symbol);
  const { change, changePct } = changeOf(q?.ltp, q?.prevClose);
  return (
    <View style={[styles.indexCard, { backgroundColor: p.surface, borderColor: p.border }]}>
      <Txt v="caption" c="muted" numberOfLines={1}>
        {inst.tradingSymbol}
      </Txt>
      <LivePrice value={q?.ltp} v="bodyStrong" align="left" />
      <Change change={change} changePct={changePct} compact align="left" />
    </View>
  );
}

function AccountStrip() {
  const p = usePalette();
  const state = useEngine();
  const quotes = useQuotes();
  const nav = useNav();
  const s = useMemo(() => accountSummary(state, quotes), [state, quotes]);
  return (
    <Pressable
      onPress={() => nav.tab('funds')}
      accessibilityRole="button"
      accessibilityLabel="Open funds"
      style={({ pressed }) => [styles.strip, { backgroundColor: p.surfaceAlt, opacity: pressed ? 0.8 : 1 }]}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt v="caption" c="muted">
          Available
        </Txt>
        <Txt v="bodyStrong" num numberOfLines={1}>
          {rupees(s.available)}
        </Txt>
      </View>
      <View style={{ flex: 1, minWidth: 0, alignItems: 'flex-end' }}>
        <Txt v="caption" c="muted">
          Today’s P&L
        </Txt>
        <Txt v="bodyStrong" num c={toneOf(p, s.dayPnl)} numberOfLines={1}>
          {signedRupees(s.dayPnl)}
        </Txt>
      </View>
    </Pressable>
  );
}

function WatchRow({ inst, onPress, onLongPress }: { inst: Instrument; onPress: () => void; onLongPress: () => void }) {
  const p = usePalette();
  const q = useQuote(inst.symbol);
  const { change, changePct } = changeOf(q?.ltp, q?.prevClose);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityHint="Long press for buy, sell and remove"
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? p.surfaceAlt : p.surface }]}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Txt v="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
            {inst.tradingSymbol}
          </Txt>
          <Txt v="caption" c="faint">
            {inst.exchange}
          </Txt>
        </View>
        <Txt v="small" c="muted" numberOfLines={1}>
          {inst.name}
        </Txt>
      </View>
      <View style={{ alignItems: 'flex-end', minWidth: 110 }}>
        <LivePrice value={q?.ltp} />
        <Change change={change} changePct={changePct} />
        <DayRange low={q?.low ?? null} high={q?.high ?? null} ltp={q?.ltp ?? null} />
      </View>
    </Pressable>
  );
}

export default function MarketsScreen() {
  const p = usePalette();
  const state = useEngine();
  const nav = useNav();
  const [refreshing, setRefreshing] = useState(false);
  const [menuFor, setMenuFor] = useState<Instrument | null>(null);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await controller.refresh();
    setRefreshing(false);
  }, []);

  const idx = menuFor ? state.watchlist.findIndex((i) => i.symbol === menuFor.symbol) : -1;

  const header = (
    <View style={{ gap: space.md, paddingBottom: space.sm }}>
      <View style={styles.brandRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Txt v="title">PaperDalal</Txt>
          <FeedLine />
        </View>
        <MarketPill />
      </View>
      <View style={styles.indexRow}>
        {INDICES.map((i) => (
          <IndexCard key={i.symbol} inst={i} />
        ))}
      </View>
      <AccountStrip />
      <Pressable
        onPress={nav.search}
        accessibilityRole="search"
        style={({ pressed }) => [styles.searchBox, { backgroundColor: p.surface, borderColor: p.border, opacity: pressed ? 0.8 : 1 }]}
      >
        <Ionicons name="search" size={18} color={p.faint} />
        <Txt v="body" c="faint">
          Search NSE & BSE stocks, ETFs
        </Txt>
      </Pressable>
      <View style={styles.listHead}>
        <Txt v="caption" c="muted">
          Watchlist · {state.watchlist.length}
        </Txt>
        <Txt v="small" c="faint">
          Long-press a stock for actions
        </Txt>
      </View>
    </View>
  );

  return (
    <Screen>
      <FlatList
        data={state.watchlist}
        keyExtractor={(i) => i.symbol}
        ListHeaderComponent={header}
        ListHeaderComponentStyle={{ paddingHorizontal: space.lg, paddingTop: space.sm }}
        renderItem={({ item }) => (
          <WatchRow inst={item} onPress={() => nav.stock(item.symbol)} onLongPress={() => setMenuFor(item)} />
        )}
        ItemSeparatorComponent={() => <Divider inset={space.lg} />}
        ListEmptyComponent={
          <Empty
            icon="eye-outline"
            title="Your watchlist is empty"
            body="Search for a stock and tap + to follow its live price here."
          />
        }
        contentContainerStyle={{ paddingBottom: space.xxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={p.accent} colors={[p.accent]} />}
      />
      <ActionSheet
        visible={!!menuFor}
        onClose={() => setMenuFor(null)}
        title={menuFor?.tradingSymbol ?? ''}
        subtitle={menuFor?.name}
        actions={
          menuFor
            ? [
                { label: 'Buy', icon: 'arrow-up-circle', tone: 'buy', onPress: () => nav.order({ symbol: menuFor.symbol, side: 'BUY' }) },
                { label: 'Sell', icon: 'arrow-down-circle', tone: 'sell', onPress: () => nav.order({ symbol: menuFor.symbol, side: 'SELL' }) },
                { label: 'View chart', icon: 'stats-chart', onPress: () => nav.stock(menuFor.symbol) },
                ...(idx > 0 ? [{ label: 'Move up', icon: 'arrow-up' as const, onPress: () => controller.moveInWatchlist(menuFor.symbol, -1) }] : []),
                ...(idx >= 0 && idx < state.watchlist.length - 1
                  ? [{ label: 'Move down', icon: 'arrow-down' as const, onPress: () => controller.moveInWatchlist(menuFor.symbol, 1) }]
                  : []),
                { label: 'Remove from watchlist', icon: 'trash-outline', tone: 'danger', onPress: () => controller.removeFromWatchlist(menuFor.symbol) },
              ]
            : []
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  indexRow: { flexDirection: 'row', gap: space.sm },
  indexCard: {
    flex: 1,
    minWidth: 0,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  strip: { flexDirection: 'row', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.md },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    minHeight: 46,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  listHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
});
