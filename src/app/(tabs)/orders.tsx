import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { describeOrder } from '@/engine/engine';
import { closedOrders, groupByDay, openOrders } from '@/engine/selectors';
import type { Fill, Order } from '@/engine/types';
import { rupees, signedRupees } from '@/lib/format';
import { formatDayKey, formatIstTime, istDayKey } from '@/lib/time';
import { controller } from '@/state/controller';
import { useEngine } from '@/state/engineStore';
import { useQuote } from '@/state/quoteStore';
import { Button, Card, Divider, Empty, KeyValue, Pill, Screen, Segmented, TopBar, Txt, type PillTone } from '@/ui/kit';
import { useNav } from '@/ui/nav';
import { LivePrice } from '@/ui/Price';
import { ConfirmSheet, Sheet } from '@/ui/Sheet';
import { space, toneOf, usePalette } from '@/ui/theme';

type Tab = 'open' | 'history' | 'trades';

const STATUS: Record<Order['status'], [string, PillTone]> = {
  OPEN: ['Open', 'accent'],
  TRIGGER_PENDING: ['Trigger pending', 'warn'],
  COMPLETE: ['Executed', 'up'],
  CANCELLED: ['Cancelled', 'neutral'],
  REJECTED: ['Rejected', 'down'],
};

function priceLabel(o: Order): string {
  if (o.type === 'MARKET') return 'Market';
  if (o.type === 'LIMIT') return `Limit ${rupees(o.price)}`;
  if (o.type === 'SL') return `Trigger ${rupees(o.triggerPrice)} · Limit ${rupees(o.price)}`;
  return `Trigger ${rupees(o.triggerPrice)} · Market`;
}

function OpenOrderRow({ o, onCancel }: { o: Order; onCancel: () => void }) {
  const nav = useNav();
  const q = useQuote(o.instrument.symbol);
  const [label, tone] = STATUS[o.status];
  return (
    <Card style={styles.card}>
      <View style={styles.cardTop}>
        <Pill label={o.side} tone={o.side === 'BUY' ? 'buy' : 'sell'} />
        <Pill label={o.product === 'MIS' ? 'MIS' : 'CNC'} />
        <Pill label={label} tone={tone} />
        {o.sessionDay === null ? <Pill label="AMO" tone="warn" icon="moon" /> : null}
        <View style={{ flex: 1 }} />
        <Txt v="small" c="faint" num>
          {formatIstTime(o.placedAt, false)}
        </Txt>
      </View>
      <View style={styles.cardMid}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Txt v="bodyStrong" numberOfLines={1}>
            {o.instrument.tradingSymbol}{' '}
            <Txt v="small" c="muted">
              × {o.qty}
            </Txt>
          </Txt>
          <Txt v="small" c="muted" numberOfLines={2}>
            {priceLabel(o)}
            {o.triggeredAt ? ' · triggered' : ''}
          </Txt>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Txt v="caption" c="faint">
            LTP
          </Txt>
          <LivePrice value={q?.ltp} v="small" />
        </View>
      </View>
      <View style={styles.cardActions}>
        <Button
          label="Modify"
          variant="secondary"
          compact
          style={{ flex: 1 }}
          onPress={() => nav.order({ symbol: o.instrument.symbol, side: o.side, orderId: o.id })}
        />
        <Button label="Cancel" variant="danger" compact style={{ flex: 1 }} onPress={onCancel} />
      </View>
    </Card>
  );
}

function HistoryRow({ o }: { o: Order }) {
  const [label, tone] = STATUS[o.status];
  return (
    <View style={styles.row}>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <Pill label={o.side} tone={o.side === 'BUY' ? 'buy' : 'sell'} />
          <Txt v="bodyStrong" numberOfLines={1}>
            {o.instrument.tradingSymbol}
          </Txt>
          <Txt v="small" c="muted">
            × {o.qty} · {o.product}
          </Txt>
        </View>
        <Txt v="small" c="muted" numberOfLines={2}>
          {o.status === 'COMPLETE' ? `Avg ${rupees(o.avgPrice)}` : priceLabel(o)}
          {o.source === 'SQUARE_OFF' ? ' · auto square-off' : ''}
          {o.message && o.status !== 'COMPLETE' ? ` · ${o.message}` : ''}
        </Txt>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 3 }}>
        <Pill label={label} tone={tone} />
        <Txt v="small" c="faint" num>
          {formatIstTime(o.filledAt ?? o.updatedAt, false)}
        </Txt>
      </View>
    </View>
  );
}

function TradeRow({ f, onPress }: { f: Fill; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: p.surfaceAlt }]} accessibilityHint="Shows the charges">
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
          <Pill label={f.side} tone={f.side === 'BUY' ? 'buy' : 'sell'} />
          <Txt v="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
            {f.instrument.tradingSymbol}
          </Txt>
        </View>
        <Txt v="small" c="muted" num>
          {f.qty} @ {rupees(f.price)} · {f.product} · charges {rupees(f.charges.total)}
        </Txt>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 3 }}>
        {f.realizedPnl !== 0 ? (
          <Txt v="bodyStrong" num c={toneOf(p, f.realizedPnl)}>
            {signedRupees(f.realizedPnl)}
          </Txt>
        ) : (
          <Txt v="small" c="faint">
            Opened
          </Txt>
        )}
        <Txt v="small" c="faint" num>
          {formatIstTime(f.time, false)}
        </Txt>
      </View>
    </Pressable>
  );
}

type Item = { kind: 'day'; day: string } | { kind: 'order'; o: Order } | { kind: 'fill'; f: Fill };

export default function OrdersScreen() {
  const state = useEngine();
  const [tab, setTab] = useState<Tab>('open');
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [fillDetail, setFillDetail] = useState<Fill | null>(null);

  const open = useMemo(() => openOrders(state), [state]);
  const items: Item[] = useMemo(() => {
    if (tab === 'open') return open.map((o) => ({ kind: 'order' as const, o }));
    if (tab === 'history') {
      return groupByDay(closedOrders(state), (o) => istDayKey(o.placedAt)).flatMap((g) => [
        { kind: 'day' as const, day: g.day },
        ...g.items.map((o) => ({ kind: 'order' as const, o })),
      ]);
    }
    return groupByDay(state.fills, (f) => f.tradingDay).flatMap((g) => [
      { kind: 'day' as const, day: g.day },
      ...g.items.map((f) => ({ kind: 'fill' as const, f })),
    ]);
  }, [tab, state, open]);

  const cancelling = cancelId ? state.orders.find((o) => o.id === cancelId) : undefined;

  return (
    <Screen>
      <TopBar title="Orders" large />
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
        <Segmented
          options={[
            { value: 'open', label: open.length ? `Open · ${open.length}` : 'Open' },
            { value: 'history', label: 'History' },
            { value: 'trades', label: 'Trades' },
          ]}
          value={tab}
          onChange={setTab}
        />
      </View>
      <FlatList
        data={items}
        keyExtractor={(it, i) => (it.kind === 'day' ? `d-${it.day}-${i}` : it.kind === 'order' ? it.o.id : it.f.id)}
        renderItem={({ item }) => {
          if (item.kind === 'day')
            return (
              <Txt v="caption" c="muted" style={styles.dayHead}>
                {formatDayKey(item.day)}
              </Txt>
            );
          if (item.kind === 'fill') return <TradeRow f={item.f} onPress={() => setFillDetail(item.f)} />;
          return tab === 'open' ? <OpenOrderRow o={item.o} onCancel={() => setCancelId(item.o.id)} /> : <HistoryRow o={item.o} />;
        }}
        ItemSeparatorComponent={tab === 'open' ? () => <View style={{ height: space.md }} /> : () => <Divider inset={space.lg} />}
        contentContainerStyle={{ paddingBottom: space.xxl, paddingTop: tab === 'open' ? space.sm : 0 }}
        ListEmptyComponent={
          tab === 'open' ? (
            <Empty icon="receipt-outline" title="No open orders" body="Limit, stop-loss and after-market orders wait here until they execute." />
          ) : tab === 'history' ? (
            <Empty icon="time-outline" title="No order history yet" body="Executed, cancelled and rejected orders appear here." />
          ) : (
            <Empty icon="swap-horizontal-outline" title="No trades yet" body="Every execution is listed here with its charges and booked P&L." />
          )
        }
      />
      <ConfirmSheet
        visible={!!cancelling}
        onClose={() => setCancelId(null)}
        title="Cancel this order?"
        body={cancelling ? describeOrder(cancelling) : ''}
        confirmLabel="Cancel order"
        destructive
        onConfirm={() => cancelling && controller.cancelOrder(cancelling.id)}
      />
      <Sheet visible={!!fillDetail} onClose={() => setFillDetail(null)} title={fillDetail ? `${fillDetail.side} ${fillDetail.qty} ${fillDetail.instrument.tradingSymbol}` : ''}>
        {fillDetail ? (
          <View>
            <KeyValue label="Price" value={rupees(fillDetail.price)} />
            <KeyValue label="Value" value={rupees(fillDetail.qty * fillDetail.price)} />
            <KeyValue label="Product" value={fillDetail.product === 'MIS' ? 'Intraday (MIS)' : 'Delivery (CNC)'} />
            <KeyValue label="Time" value={`${formatDayKey(fillDetail.tradingDay)}, ${formatIstTime(fillDetail.time)}`} />
            {fillDetail.note ? <KeyValue label="Note" value={fillDetail.note} /> : null}
            <Divider />
            <KeyValue label="Brokerage" value={rupees(fillDetail.charges.brokerage)} />
            <KeyValue label="STT" value={rupees(fillDetail.charges.stt)} />
            <KeyValue label="Exchange txn" value={rupees(fillDetail.charges.exchange)} />
            <KeyValue label="SEBI fee" value={rupees(fillDetail.charges.sebi)} />
            <KeyValue label="Stamp duty" value={rupees(fillDetail.charges.stamp)} />
            <KeyValue label="GST" value={rupees(fillDetail.charges.gst)} />
            {fillDetail.charges.dp ? <KeyValue label="DP charge" value={rupees(fillDetail.charges.dp)} /> : null}
            <KeyValue label="Total charges" value={rupees(fillDetail.charges.total)} strong />
            {fillDetail.realizedPnl !== 0 ? (
              <KeyValue label="Booked P&L (before charges)" value={signedRupees(fillDetail.realizedPnl)} strong />
            ) : null}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: space.lg, gap: space.md },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  cardMid: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  cardActions: { flexDirection: 'row', gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  dayHead: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.xs },
});
