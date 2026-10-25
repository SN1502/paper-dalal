import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { holdingViews, positionViews, type HoldingView, type PositionView } from '@/engine/selectors';
import { pct, rupees, signedRupees } from '@/lib/format';
import { formatDayKey } from '@/lib/time';
import { useEngine } from '@/state/engineStore';
import { useQuotes } from '@/state/quoteStore';
import { Card, Divider, Empty, Pill, Screen, Segmented, Stat, TopBar, Txt } from '@/ui/kit';
import { useNav } from '@/ui/nav';
import { LivePrice } from '@/ui/Price';
import { ActionSheet } from '@/ui/Sheet';
import { space, toneOf, usePalette } from '@/ui/theme';

type Tab = 'positions' | 'holdings';

function PositionRow({ v, onPress }: { v: PositionView; onPress: () => void }) {
  const p = usePalette();
  const { pos } = v;
  const closed = pos.netQty === 0;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, { backgroundColor: pressed ? p.surfaceAlt : p.surface, opacity: closed ? 0.7 : 1 }]}>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Pill label={pos.product} tone={pos.product === 'MIS' ? 'warn' : 'accent'} />
          <Txt v="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
            {pos.instrument.tradingSymbol}
          </Txt>
        </View>
        <Txt v="small" c="muted" num numberOfLines={1}>
          {closed ? `Closed · ${pos.buyQty} bought, ${pos.sellQty} sold` : `${pos.netQty > 0 ? 'Qty' : 'Short'} ${Math.abs(pos.netQty)} · Avg ${rupees(pos.avgPrice)}`}
        </Txt>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <Txt v="bodyStrong" num c={toneOf(p, v.pnl)}>
          {signedRupees(v.pnl)}
        </Txt>
        <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
          <Txt v="small" c="faint">
            LTP
          </Txt>
          <LivePrice value={v.ltp} v="small" />
        </View>
      </View>
    </Pressable>
  );
}

function HoldingRow({ v, onPress }: { v: HoldingView; onPress: () => void }) {
  const p = usePalette();
  const h = v.holding;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, { backgroundColor: pressed ? p.surfaceAlt : p.surface }]}>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Txt v="bodyStrong" numberOfLines={1}>
          {h.instrument.tradingSymbol}
        </Txt>
        <Txt v="small" c="muted" num numberOfLines={1}>
          {h.qty} × {rupees(h.avgPrice)} · since {formatDayKey(h.since)}
        </Txt>
        <Txt v="small" c={toneOf(p, v.dayChange)} num>
          Today {signedRupees(v.dayChange)}
          {v.dayChangePct !== null ? ` (${pct(v.dayChangePct)})` : ''}
        </Txt>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <Txt v="bodyStrong" num c={toneOf(p, v.pnl)}>
          {signedRupees(v.pnl)}
        </Txt>
        <Txt v="small" num c={toneOf(p, v.pnl)}>
          {pct(v.pnlPct)}
        </Txt>
        <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
          <Txt v="small" c="faint">
            LTP
          </Txt>
          <LivePrice value={v.ltp} v="small" />
        </View>
      </View>
    </Pressable>
  );
}

export default function PortfolioScreen() {
  const p = usePalette();
  const state = useEngine();
  const quotes = useQuotes();
  const nav = useNav();
  const [tab, setTab] = useState<Tab>('positions');
  const [menuPos, setMenuPos] = useState<PositionView | null>(null);
  const [menuHold, setMenuHold] = useState<HoldingView | null>(null);

  const positions = useMemo(() => positionViews(state, quotes), [state, quotes]);
  const holdings = useMemo(() => holdingViews(state, quotes), [state, quotes]);

  const posTotals = useMemo(() => {
    let realized = 0;
    let unrealized = 0;
    for (const v of positions) {
      realized += v.pos.realizedPnl;
      unrealized += v.unrealized;
    }
    let charges = 0;
    for (const f of state.fills) {
      if (f.tradingDay !== state.tradingDay) break;
      charges += f.charges.total;
    }
    return { realized, unrealized, total: realized + unrealized, charges };
  }, [positions, state.fills, state.tradingDay]);

  const holdTotals = useMemo(() => {
    let invested = 0;
    let current = 0;
    let day = 0;
    for (const v of holdings) {
      invested += v.invested;
      current += v.current;
      day += v.dayChange;
    }
    return { invested, current, pnl: current - invested, pnlPct: invested > 0 ? ((current - invested) / invested) * 100 : 0, day };
  }, [holdings]);

  const summary =
    tab === 'positions' ? (
      <Card style={styles.summary}>
        <Txt v="caption" c="muted">
          Today’s P&L on positions
        </Txt>
        <Txt v="display" num c={toneOf(p, posTotals.total)}>
          {signedRupees(posTotals.total)}
        </Txt>
        <View style={styles.statRow}>
          <Stat label="Realised" value={signedRupees(posTotals.realized)} tone={toneOf(p, posTotals.realized)} />
          <Stat label="Unrealised" value={signedRupees(posTotals.unrealized)} tone={toneOf(p, posTotals.unrealized)} align="right" />
        </View>
        {posTotals.charges > 0 ? (
          <Txt v="small" c="faint" num>
            Before today’s charges of {rupees(posTotals.charges)}
          </Txt>
        ) : null}
      </Card>
    ) : (
      <Card style={styles.summary}>
        <Txt v="caption" c="muted">
          Current value
        </Txt>
        <Txt v="display" num>
          {rupees(holdTotals.current)}
        </Txt>
        <View style={styles.statRow}>
          <Stat label="Invested" value={rupees(holdTotals.invested)} />
          <Stat
            label="Total P&L"
            value={`${signedRupees(holdTotals.pnl)} (${pct(holdTotals.pnlPct)})`}
            tone={toneOf(p, holdTotals.pnl)}
            align="right"
          />
        </View>
        <Divider />
        <View style={styles.statRow}>
          <Txt v="small" c="muted">
            Today’s change
          </Txt>
          <Txt v="smallStrong" num c={toneOf(p, holdTotals.day)}>
            {signedRupees(holdTotals.day)}
          </Txt>
        </View>
      </Card>
    );

  return (
    <Screen>
      <TopBar title="Portfolio" large />
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
        <Segmented
          options={[
            { value: 'positions', label: positions.length ? `Positions · ${positions.length}` : 'Positions' },
            { value: 'holdings', label: holdings.length ? `Holdings · ${holdings.length}` : 'Holdings' },
          ]}
          value={tab}
          onChange={setTab}
        />
      </View>
      {tab === 'positions' ? (
        <FlatList
          data={positions}
          keyExtractor={(v) => v.pos.key}
          ListHeaderComponent={positions.length ? summary : undefined}
          renderItem={({ item }) => <PositionRow v={item} onPress={() => setMenuPos(item)} />}
          ItemSeparatorComponent={() => <Divider inset={space.lg} />}
          ListEmptyComponent={
            <Empty
              icon="layers-outline"
              title="No positions today"
              body="Intraday trades and today’s delivery buys show up here. Delivery buys move to Holdings the next day."
            />
          }
          contentContainerStyle={{ paddingBottom: space.xxl }}
        />
      ) : (
        <FlatList
          data={holdings}
          keyExtractor={(v) => v.holding.instrument.symbol}
          ListHeaderComponent={holdings.length ? summary : undefined}
          renderItem={({ item }) => <HoldingRow v={item} onPress={() => setMenuHold(item)} />}
          ItemSeparatorComponent={() => <Divider inset={space.lg} />}
          ListEmptyComponent={
            <Empty icon="briefcase-outline" title="No holdings yet" body="Buy with Delivery (CNC). Shares settle into Holdings on the next trading day." />
          }
          contentContainerStyle={{ paddingBottom: space.xxl }}
        />
      )}

      <ActionSheet
        visible={!!menuPos}
        onClose={() => setMenuPos(null)}
        title={menuPos ? `${menuPos.pos.instrument.tradingSymbol} · ${menuPos.pos.product}` : ''}
        subtitle={menuPos && menuPos.pos.netQty !== 0 ? `${menuPos.pos.netQty > 0 ? 'Long' : 'Short'} ${Math.abs(menuPos.pos.netQty)}` : 'Closed position'}
        actions={
          menuPos
            ? [
                ...(menuPos.pos.netQty !== 0
                  ? [
                      {
                        label: `Exit ${Math.abs(menuPos.pos.netQty)}`,
                        icon: 'exit-outline' as const,
                        tone: (menuPos.pos.netQty > 0 ? 'sell' : 'buy') as 'sell' | 'buy',
                        onPress: () =>
                          nav.order({
                            symbol: menuPos.pos.instrument.symbol,
                            side: menuPos.pos.netQty > 0 ? 'SELL' : 'BUY',
                            product: menuPos.pos.product,
                            qty: Math.abs(menuPos.pos.netQty),
                          }),
                      },
                    ]
                  : []),
                {
                  label: 'Add',
                  icon: 'add-circle-outline' as const,
                  tone: (menuPos.pos.netQty < 0 ? 'sell' : 'buy') as 'sell' | 'buy',
                  onPress: () =>
                    nav.order({ symbol: menuPos.pos.instrument.symbol, side: menuPos.pos.netQty < 0 ? 'SELL' : 'BUY', product: menuPos.pos.product }),
                },
                { label: 'View chart', icon: 'stats-chart' as const, onPress: () => nav.stock(menuPos.pos.instrument.symbol) },
              ]
            : []
        }
      />
      <ActionSheet
        visible={!!menuHold}
        onClose={() => setMenuHold(null)}
        title={menuHold?.holding.instrument.tradingSymbol ?? ''}
        subtitle={menuHold ? `${menuHold.holding.qty} shares · avg ${rupees(menuHold.holding.avgPrice)}` : ''}
        actions={
          menuHold
            ? [
                {
                  label: 'Sell',
                  icon: 'arrow-down-circle',
                  tone: 'sell',
                  onPress: () => nav.order({ symbol: menuHold.holding.instrument.symbol, side: 'SELL', product: 'CNC', qty: menuHold.holding.qty }),
                },
                {
                  label: 'Buy more',
                  icon: 'arrow-up-circle',
                  tone: 'buy',
                  onPress: () => nav.order({ symbol: menuHold.holding.instrument.symbol, side: 'BUY', product: 'CNC' }),
                },
                { label: 'View chart', icon: 'stats-chart', onPress: () => nav.stock(menuHold.holding.instrument.symbol) },
              ]
            : []
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  summary: { marginHorizontal: space.lg, marginBottom: space.md, gap: space.sm },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
});
