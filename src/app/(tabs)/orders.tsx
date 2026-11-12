import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { describeOrder } from '@/engine/engine';
import { closedOrders, groupByDay, openOrders } from '@/engine/selectors';
import type { Fill, Gtt, Order } from '@/engine/types';
import { rupees, signedRupees } from '@/lib/format';
import { formatDayKey, formatIstTime, istDayKey } from '@/lib/time';
import { controller } from '@/state/controller';
import { useEngine } from '@/state/engineStore';
import { useQuote } from '@/state/quoteStore';
import { Button, Card, Divider, Empty, KeyValue, Pill, Screen, Segmented, TopBar, Txt, type PillTone } from '@/ui/kit';
import { useNav } from '@/ui/nav';
import { LivePrice } from '@/ui/Price';
import { ExitSheet } from '@/ui/ExitSheet';
import { ConfirmSheet, Sheet } from '@/ui/Sheet';
import { space, toneOf, usePalette } from '@/ui/theme';

type Tab = 'open' | 'exits' | 'history' | 'trades';

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
          {o.source === 'SQUARE_OFF' ? ' · auto square-off' : o.source === 'GTT' ? ' · exit (stop-loss/target)' : o.source === 'AI' ? ' · by AI' : ''}
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

type Item = { kind: 'day'; day: string } | { kind: 'order'; o: Order } | { kind: 'fill'; f: Fill } | { kind: 'gtt'; g: Gtt };

function GttRow({ g, onEdit, onCancel }: { g: Gtt; onEdit: () => void; onCancel: () => void }) {
  const p = usePalette();
  const q = useQuote(g.instrument.symbol);
  const ltp = q?.ltp ?? null;
  const active = g.status === 'ACTIVE';
  const toStop = ltp !== null && g.stopPrice !== null ? ((g.stopPrice - ltp) / ltp) * 100 : null;
  const toTarget = ltp !== null && g.targetPrice !== null ? ((g.targetPrice - ltp) / ltp) * 100 : null;
  return (
    <View style={[styles.row, { opacity: active ? 1 : 0.7 }]}>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <Txt v="bodyStrong">{g.instrument.tradingSymbol}</Txt>
          <Txt v="small" c="muted">
            × {g.qty}
          </Txt>
          <Pill label={g.source === 'AI' ? 'AI' : 'You'} tone={g.source === 'AI' ? 'accent' : 'neutral'} />
          <Pill label={(g.product ?? 'CNC') === 'MIS' ? (g.exitSide === 'BUY' ? 'Intraday short' : 'Intraday') : 'Delivery'} tone={(g.product ?? 'CNC') === 'MIS' ? 'warn' : 'neutral'} />
          {!active ? (
            <Pill
              label={g.status === 'TRIGGERED' ? (g.triggeredLeg === 'STOP' ? 'Stop hit' : 'Target hit') : 'Cancelled'}
              tone={g.status === 'TRIGGERED' ? (g.triggeredLeg === 'STOP' ? 'down' : 'up') : 'neutral'}
            />
          ) : null}
        </View>
        <Txt v="small" c="muted" num>
          SL {g.stopPrice !== null ? rupees(g.stopPrice) : '—'}
          {active && toStop !== null ? ` (${toStop.toFixed(1)}%)` : ''} · Target {g.targetPrice !== null ? rupees(g.targetPrice) : '—'}
          {active && toTarget !== null ? ` (${toTarget >= 0 ? '+' : ''}${toTarget.toFixed(1)}%)` : ''}
        </Txt>
        {!active && g.triggerPrice !== null ? (
          <Txt v="small" c="faint" num>
            {g.exitSide === 'BUY' ? 'Bought back' : 'Sold'} at {rupees(g.triggerPrice)} · {formatDayKey(istDayKey(g.updatedAt))}
          </Txt>
        ) : null}
        {!active && g.status === 'CANCELLED' && g.message ? (
          <Txt v="small" c="faint">
            {g.message}
          </Txt>
        ) : null}
      </View>
      {active ? (
        <View style={{ gap: 6 }}>
          <Button label="Edit" variant="secondary" compact onPress={onEdit} />
          <Button label="Cancel" variant="danger" compact onPress={onCancel} />
        </View>
      ) : (
        <View style={{ alignItems: 'flex-end' }}>
          <Txt v="caption" c="faint">
            LTP
          </Txt>
          <Txt v="small" num c={p.muted}>
            {ltp !== null ? rupees(ltp) : '—'}
          </Txt>
        </View>
      )}
    </View>
  );
}

export default function OrdersScreen() {
  const state = useEngine();
  const [tab, setTab] = useState<Tab>('open');
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [fillDetail, setFillDetail] = useState<Fill | null>(null);
  const [editGtt, setEditGtt] = useState<Gtt | null>(null);
  const [cancelGttId, setCancelGttId] = useState<string | null>(null);

  const open = useMemo(() => openOrders(state), [state]);
  const items: Item[] = useMemo(() => {
    if (tab === 'open') return open.map((o) => ({ kind: 'order' as const, o }));
    if (tab === 'exits') {
      const active = state.gtts.filter((g) => g.status === 'ACTIVE');
      const done = state.gtts.filter((g) => g.status !== 'ACTIVE').slice(0, 40);
      return [...active, ...done].map((g) => ({ kind: 'gtt' as const, g }));
    }
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
  const activeExits = state.gtts.filter((g) => g.status === 'ACTIVE').length;
  const cancellingGtt = cancelGttId ? state.gtts.find((g) => g.id === cancelGttId) : undefined;

  return (
    <Screen>
      <TopBar title="Orders" large />
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
        <Segmented
          options={[
            { value: 'open', label: open.length ? `Open · ${open.length}` : 'Open' },
            { value: 'exits', label: activeExits ? `Exits · ${activeExits}` : 'Exits' },
            { value: 'history', label: 'History' },
            { value: 'trades', label: 'Trades' },
          ]}
          value={tab}
          onChange={setTab}
        />
      </View>
      <FlatList
        data={items}
        keyExtractor={(it, i) => (it.kind === 'day' ? `d-${it.day}-${i}` : it.kind === 'order' ? it.o.id : it.kind === 'gtt' ? it.g.id : it.f.id)}
        renderItem={({ item }) => {
          if (item.kind === 'day')
            return (
              <Txt v="caption" c="muted" style={styles.dayHead}>
                {formatDayKey(item.day)}
              </Txt>
            );
          if (item.kind === 'fill') return <TradeRow f={item.f} onPress={() => setFillDetail(item.f)} />;
          if (item.kind === 'gtt') return <GttRow g={item.g} onEdit={() => setEditGtt(item.g)} onCancel={() => setCancelGttId(item.g.id)} />;
          return tab === 'open' ? <OpenOrderRow o={item.o} onCancel={() => setCancelId(item.o.id)} /> : <HistoryRow o={item.o} />;
        }}
        ItemSeparatorComponent={tab === 'open' ? () => <View style={{ height: space.md }} /> : () => <Divider inset={space.lg} />}
        contentContainerStyle={{ paddingBottom: space.xxl, paddingTop: tab === 'open' ? space.sm : 0 }}
        ListEmptyComponent={
          tab === 'open' ? (
            <Empty icon="receipt-outline" title="No open orders" body="Limit, stop-loss and after-market orders wait here until they execute." />
          ) : tab === 'exits' ? (
            <Empty
              icon="shield-checkmark-outline"
              title="No exits set"
              body="Stop-loss and target exits appear here. The AI sets one on every trade it opens; you can add your own to delivery holdings from a stock’s page."
            />
          ) : tab === 'history' ? (
            <Empty icon="time-outline" title="No order history yet" body="Executed, cancelled and rejected orders appear here." />
          ) : (
            <Empty icon="swap-horizontal-outline" title="No trades yet" body="Every execution is listed here with its charges and booked P&L." />
          )
        }
      />
      <ExitSheet visible={!!editGtt} onClose={() => setEditGtt(null)} instrument={editGtt?.instrument ?? null} existing={editGtt} />
      <ConfirmSheet
        visible={!!cancellingGtt}
        onClose={() => setCancelGttId(null)}
        title="Cancel this exit?"
        body={cancellingGtt ? `${cancellingGtt.instrument.tradingSymbol} will no longer be sold automatically at its stop-loss or target.` : ''}
        confirmLabel="Cancel exit"
        destructive
        onConfirm={() => cancellingGtt && controller.cancelGtt(cancellingGtt.id)}
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
