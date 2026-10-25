import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { computeCharges } from '@/engine/charges';
import {
  computeFunds,
  estimateBlock,
  isLiveQuote,
  pricesFromQuotes,
  roundToTick,
  sellableQty,
  tickSize,
  validateOrder,
} from '@/engine/engine';
import type { OrderInput, OrderType, Product, Side } from '@/engine/types';
import { num, parseAmount, rupees } from '@/lib/format';
import { formatHHMM, parseHHMM } from '@/lib/time';
import { controller } from '@/state/controller';
import { useEngine } from '@/state/engineStore';
import { useQuote, useQuotes } from '@/state/quoteStore';
import { NumberField } from '@/ui/Field';
import { Button, Divider, KeyValue, Pill, Screen, Segmented, Txt } from '@/ui/kit';
import { Change, LivePrice, changeOf } from '@/ui/Price';
import { radius, space, usePalette } from '@/ui/theme';

const TYPES: { value: OrderType; label: string }[] = [
  { value: 'MARKET', label: 'Market' },
  { value: 'LIMIT', label: 'Limit' },
  { value: 'SL', label: 'SL' },
  { value: 'SL-M', label: 'SL-M' },
];

const TYPE_HELP: Record<OrderType, string> = {
  MARKET: 'Executes right away at the best available price.',
  LIMIT: 'Executes only at your price or better.',
  SL: 'Stop-loss: when the trigger is hit, a limit order is placed at your price.',
  'SL-M': 'Stop-loss market: when the trigger is hit, it executes at market.',
};

export default function OrderScreen() {
  const params = useLocalSearchParams<{ symbol: string; side?: string; product?: string; qty?: string; type?: string; orderId?: string }>();
  const symbol = decodeURIComponent(String(params.symbol ?? ''));
  const router = useRouter();
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const state = useEngine();
  const quotes = useQuotes();
  const q = useQuote(symbol);
  const inst = useMemo(() => controller.instrumentFor(symbol), [symbol]);
  const editing = params.orderId ? state.orders.find((o) => o.id === params.orderId) : undefined;

  const [side, setSide] = useState<Side>((editing?.side ?? (params.side === 'SELL' ? 'SELL' : 'BUY')) as Side);
  const [product, setProduct] = useState<Product>(() => {
    if (editing) return editing.product;
    if (params.product === 'MIS' || params.product === 'CNC') return params.product;
    // Selling something you don't hold defaults to intraday, where shorting is allowed.
    if (params.side === 'SELL' && sellableQty(state, symbol) === 0) return 'MIS';
    return 'CNC';
  });
  const [type, setType] = useState<OrderType>((editing?.type ?? (params.type as OrderType)) || 'MARKET');
  const [qtyText, setQtyText] = useState(String(editing?.qty ?? (params.qty ? Number(params.qty) : 1)));
  const [priceText, setPriceText] = useState(editing?.price ? String(editing.price) : '');
  const [triggerText, setTriggerText] = useState(editing?.triggerPrice ? String(editing.triggerPrice) : '');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [showCharges, setShowCharges] = useState(false);

  useEffect(() => controller.focusSymbol(inst), [inst]);

  // Pre-fill prices from the live quote the first time one is available.
  useEffect(() => {
    if (!q) return;
    if (!priceText) setPriceText(String(roundToTick(q.ltp)));
    if (!triggerText) {
      const t = side === 'BUY' ? roundToTick(q.ltp * 1.01, 'up') : roundToTick(q.ltp * 0.99, 'down');
      setTriggerText(String(t));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q?.symbol]);

  const ltp = q?.ltp ?? null;
  const qty = Number(qtyText);
  const price = type === 'LIMIT' || type === 'SL' ? parseAmount(priceText) : null;
  const trigger = type === 'SL' || type === 'SL-M' ? parseAmount(triggerText) : null;

  const input: OrderInput = {
    instrument: inst,
    side,
    product,
    type,
    qty: Number.isFinite(qty) ? qty : 0,
    price: price !== null && Number.isFinite(price) ? price : null,
    triggerPrice: trigger !== null && Number.isFinite(trigger) ? trigger : null,
  };

  const prices = useMemo(() => pricesFromQuotes(quotes), [quotes]);
  const now = Date.now();
  const error = validateOrder(state, input, { now, ltp, prices, excludeOrderId: editing?.id });
  const ref = type === 'LIMIT' || type === 'SL' ? input.price : type === 'SL-M' ? input.triggerPrice : ltp;
  const refPrice = ref ?? ltp ?? 0;
  const value = input.qty * refPrice;
  const need = input.qty > 0 && refPrice > 0 ? estimateBlock(state, input, refPrice) : 0;
  const funds = computeFunds(state, prices);
  const available = funds.available + (editing?.blockedAmount ?? 0);
  const charges = computeCharges({ product, side, exchange: inst.exchange, qty: Math.max(0, input.qty), price: refPrice });
  const canSell = sellableQty(state, symbol, editing?.id);
  const live = !!q && isLiveQuote(q, now);
  const sqMin = parseHHMM(state.settings.squareOffTime);
  const { change, changePct } = changeOf(q?.ltp, q?.prevClose);
  const sideColor = side === 'BUY' ? p.buy : p.sell;

  const step = (setter: (s: string) => void, current: string, dir: 1 | -1) => {
    const v = parseAmount(current);
    const base = Number.isFinite(v) && v > 0 ? v : (ltp ?? 0);
    setter(String(roundToTick(Math.max(tickSize(base), base + dir * tickSize(base)))));
  };

  const submit = async () => {
    setSubmitted(true);
    setServerError(null);
    if (error) return;
    setBusy(true);
    const res = editing
      ? await controller.modifyOrder(editing.id, { qty: input.qty, type, price: input.price, triggerPrice: input.triggerPrice })
      : await controller.placeOrder(input);
    setBusy(false);
    if (res.error) {
      setServerError(res.error);
      return;
    }
    router.back();
  };

  const shownError = serverError ?? (submitted ? error : null);
  const qtyInvalid = submitted && (!Number.isInteger(qty) || qty < 1);

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={[styles.header, { borderBottomColor: p.border }]}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <Txt v="title" c={sideColor} numberOfLines={1} style={{ flexShrink: 1 }}>
                {editing ? 'Modify' : side === 'BUY' ? 'Buy' : 'Sell'} {inst.tradingSymbol}
              </Txt>
              <Txt v="caption" c="faint">
                {inst.exchange}
              </Txt>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <LivePrice value={ltp} v="small" align="left" />
              <Change change={change} changePct={changePct} align="left" />
            </View>
          </View>
          {!editing ? (
            <Pressable
              onPress={() => setSide(side === 'BUY' ? 'SELL' : 'BUY')}
              accessibilityRole="switch"
              accessibilityState={{ checked: side === 'SELL' }}
              accessibilityLabel="Switch between buy and sell"
              style={[styles.sideSwitch, { backgroundColor: p.surfaceAlt }]}
            >
              <View style={[styles.sideKnob, { backgroundColor: side === 'BUY' ? p.buy : 'transparent' }]}>
                <Txt v="smallStrong" c={side === 'BUY' ? p.onAccent : p.muted}>
                  B
                </Txt>
              </View>
              <View style={[styles.sideKnob, { backgroundColor: side === 'SELL' ? p.sell : 'transparent' }]}>
                <Txt v="smallStrong" c={side === 'SELL' ? p.onAccent : p.muted}>
                  S
                </Txt>
              </View>
            </Pressable>
          ) : null}
          <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
            <Ionicons name="close" size={26} color={p.muted} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
          <View style={{ gap: space.sm }}>
            <Txt v="caption" c="muted">
              Product
            </Txt>
            {editing ? (
              <Pill label={product === 'MIS' ? 'Intraday (MIS)' : 'Delivery (CNC)'} tone="accent" />
            ) : (
              <Segmented
                options={[
                  { value: 'MIS', label: 'Intraday · MIS' },
                  { value: 'CNC', label: 'Delivery · CNC' },
                ]}
                value={product}
                onChange={setProduct}
                activeColor={sideColor}
              />
            )}
            <Txt v="small" c="faint">
              {product === 'MIS'
                ? `${state.settings.misLeverage}x leverage. Open positions are squared off at ${formatHHMM(sqMin)}.`
                : side === 'SELL'
                  ? `You can sell ${canSell} share${canSell === 1 ? '' : 's'} you hold.`
                  : 'Full value is paid; shares move to Holdings the next day.'}
            </Txt>
          </View>

          <View style={{ flexDirection: 'row', gap: space.md }}>
            <NumberField
              id="qty"
              label="Quantity"
              value={qtyText}
              onChangeText={setQtyText}
              integer
              invalid={qtyInvalid}
              onStep={(d) => setQtyText(String(Math.max(1, (Number(qtyText) || 0) + d)))}
            />
            <NumberField
              id="price"
              label="Price"
              prefix={type === 'MARKET' || type === 'SL-M' ? undefined : '₹'}
              value={type === 'MARKET' || type === 'SL-M' ? 'Market' : priceText}
              onChangeText={setPriceText}
              disabled={type === 'MARKET' || type === 'SL-M'}
              onStep={(d) => step(setPriceText, priceText, d)}
            />
          </View>

          <View style={{ gap: space.sm }}>
            <Segmented options={TYPES} value={type} onChange={setType} activeColor={sideColor} />
            <Txt v="small" c="faint">
              {TYPE_HELP[type]}
            </Txt>
          </View>

          {type === 'SL' || type === 'SL-M' ? (
            <View style={{ flexDirection: 'row' }}>
              <NumberField
                id="trigger"
                label="Trigger price"
                prefix="₹"
                value={triggerText}
                onChangeText={setTriggerText}
                onStep={(d) => step(setTriggerText, triggerText, d)}
                hint={
                  ltp !== null
                    ? side === 'BUY'
                      ? `Triggers when the price rises to this level (now ${num(ltp)}).`
                      : `Triggers when the price falls to this level (now ${num(ltp)}).`
                    : undefined
                }
              />
            </View>
          ) : null}

          {!live ? (
            <View style={[styles.notice, { backgroundColor: p.warnSoft }]}>
              <Ionicons name="moon-outline" size={18} color={p.warn} />
              <Txt v="small" c={p.warn} style={{ flex: 1 }}>
                The market isn’t trading right now. This goes in as an after-market order and is checked from 9:15 AM on the next
                trading day.
              </Txt>
            </View>
          ) : null}

          <View style={[styles.summary, { backgroundColor: p.surface, borderColor: p.border }]}>
            <KeyValue label="Order value (approx.)" value={rupees(value)} />
            <KeyValue
              label={product === 'MIS' ? 'Margin required' : 'Funds required'}
              value={rupees(need)}
              strong
            />
            <KeyValue label="Available" value={rupees(available)} tone={need > available ? p.down : undefined} />
            <Divider />
            <Pressable onPress={() => setShowCharges((x) => !x)} accessibilityRole="button" accessibilityState={{ expanded: showCharges }}>
              <View style={styles.chargesHead}>
                <Txt v="small" c="muted">
                  Charges (est.)
                </Txt>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Txt v="small" num>
                    {rupees(charges.total)}
                  </Txt>
                  <Ionicons name={showCharges ? 'chevron-up' : 'chevron-down'} size={14} color={p.muted} />
                </View>
              </View>
            </Pressable>
            {showCharges ? (
              <View style={{ paddingLeft: space.sm }}>
                <KeyValue label="Brokerage" value={rupees(charges.brokerage)} />
                <KeyValue label="STT" value={rupees(charges.stt)} />
                <KeyValue label="Exchange txn" value={rupees(charges.exchange)} />
                <KeyValue label="SEBI fee" value={rupees(charges.sebi)} />
                <KeyValue label="Stamp duty" value={rupees(charges.stamp)} />
                <KeyValue label="GST" value={rupees(charges.gst)} />
                {product === 'CNC' && side === 'SELL' ? (
                  <Txt v="small" c="faint">
                    A DP charge of {rupees(state.settings.dpChargePerScrip)} applies once a day when you sell from holdings.
                  </Txt>
                ) : null}
              </View>
            ) : null}
          </View>

          {shownError ? (
            <View style={[styles.notice, { backgroundColor: p.downSoft }]} accessibilityLiveRegion="polite">
              <Ionicons name="alert-circle" size={18} color={p.down} />
              <Txt v="small" c={p.down} style={{ flex: 1 }}>
                {shownError}
              </Txt>
            </View>
          ) : null}
        </ScrollView>

        <View style={[styles.footer, { backgroundColor: p.surface, borderTopColor: p.border, paddingBottom: Math.max(insets.bottom, space.md) }]}>
          <Button
            label={
              editing
                ? 'Save changes'
                : `${side === 'BUY' ? 'Buy' : 'Sell'} ${Number.isFinite(qty) && qty > 0 ? qty : ''} ${inst.tradingSymbol}`
            }
            variant={side === 'BUY' ? 'buy' : 'sell'}
            loading={busy}
            onPress={submit}
            disabled={inst.isIndex}
          />
          <Txt v="small" c="faint" align="center">
            Paper trade · no real money or orders
          </Txt>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sideSwitch: { flexDirection: 'row', borderRadius: radius.pill, padding: 3 },
  sideKnob: { width: 32, height: 28, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  notice: { flexDirection: 'row', gap: space.sm, padding: space.md, borderRadius: radius.md, alignItems: 'flex-start' },
  summary: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, paddingHorizontal: space.lg, paddingVertical: space.sm },
  chargesHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  footer: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
});
