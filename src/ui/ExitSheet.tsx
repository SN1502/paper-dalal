import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { heldQty, roundToTick } from '../engine/engine';
import type { Gtt, Instrument } from '../engine/types';
import { num, parseAmount } from '../lib/format';
import { controller } from '../state/controller';
import { engineStore } from '../state/engineStore';
import { quoteStore } from '../state/quoteStore';
import { NumberField } from './Field';
import { Button, Txt } from './kit';
import { Sheet } from './Sheet';
import { space } from './theme';

/** Create or edit a stop-loss/target exit (GTT) on a delivery position. */
export function ExitSheet({
  visible,
  onClose,
  instrument,
  existing,
}: {
  visible: boolean;
  onClose: () => void;
  instrument: Instrument | null;
  existing: Gtt | null;
}) {
  const [stop, setStop] = useState('');
  const [target, setTarget] = useState('');
  const [qty, setQty] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible || !instrument) return;
    setError(null);
    const ltp = quoteStore.get(instrument.symbol)?.ltp ?? null;
    if (existing) {
      setStop(existing.stopPrice !== null ? String(existing.stopPrice) : '');
      setTarget(existing.targetPrice !== null ? String(existing.targetPrice) : '');
      setQty(String(existing.qty));
    } else {
      setStop(ltp ? String(roundToTick(ltp * 0.95, 'down')) : '');
      setTarget(ltp ? String(roundToTick(ltp * 1.1, 'up')) : '');
      setQty(String(heldQty(engineStore.get(), instrument.symbol)));
    }
  }, [visible, instrument, existing]);

  if (!instrument) return null;
  const ltp = quoteStore.get(instrument.symbol)?.ltp ?? null;
  const held = heldQty(engineStore.get(), instrument.symbol);

  const save = async () => {
    const s = stop.trim() ? parseAmount(stop) : null;
    const t = target.trim() ? parseAmount(target) : null;
    const q = Number(qty);
    if ((s !== null && !Number.isFinite(s)) || (t !== null && !Number.isFinite(t))) {
      setError('Enter prices as numbers, like 1450.50.');
      return;
    }
    setBusy(true);
    const err = existing
      ? controller.updateGtt(existing.id, { stopPrice: s, targetPrice: t, qty: q }).error
      : await controller.createGtt(instrument, q, s, t);
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };

  const step = (setter: (v: string) => void, cur: string, dir: 1 | -1) => {
    const v = parseAmount(cur);
    const base = Number.isFinite(v) && v > 0 ? v : (ltp ?? 0);
    setter(String(roundToTick(Math.max(0.05, base + dir * (base < 250 ? 0.05 : 0.5)))));
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={`${existing ? 'Edit' : 'Add'} exit · ${instrument.tradingSymbol}`}>
      <Txt v="small" c="muted" style={{ marginBottom: space.md }}>
        Sells at market when the price falls to the stop-loss or rises to the target, whichever comes first. Stays active across
        days until it triggers or you cancel it.{ltp !== null ? ` Last price ${num(ltp)}.` : ''}
      </Txt>
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <NumberField id="exit-stop" label="Stop-loss" prefix="₹" value={stop} onChangeText={setStop} onStep={(d) => step(setStop, stop, d)} />
        <NumberField id="exit-target" label="Target" prefix="₹" value={target} onChangeText={setTarget} onStep={(d) => step(setTarget, target, d)} />
      </View>
      <View style={{ flexDirection: 'row', marginTop: space.md }}>
        <NumberField id="exit-qty" label={`Quantity (you hold ${held})`} value={qty} onChangeText={setQty} integer />
      </View>
      {error ? (
        <Txt v="small" c="down" style={{ marginTop: space.md }}>
          {error}
        </Txt>
      ) : null}
      <Button label={existing ? 'Save exit' : 'Add exit'} onPress={save} loading={busy} style={{ marginTop: space.lg }} />
    </Sheet>
  );
}
