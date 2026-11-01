import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, View } from 'react-native';

import type { AiDecision, AiStep } from '../ai/types';
import { rupees } from '../lib/format';
import { formatDayKey, formatIstTime, istDayKey } from '../lib/time';
import { Pill, Txt, type IconName, type PillTone } from './kit';
import { useNav } from './nav';
import { space, usePalette } from './theme';

export function whenLabel(t: number): string {
  const today = istDayKey(Date.now());
  const day = istDayKey(t);
  if (day === today) return `today, ${formatIstTime(t, false)}`;
  return `${formatDayKey(day)}, ${formatIstTime(t, false)}`;
}

export function DecisionRow({ d }: { d: AiDecision }) {
  const nav = useNav();
  const tone: PillTone = d.outcome === 'rejected' ? 'down' : d.action === 'BUY' ? 'buy' : d.action === 'SELL' ? 'sell' : 'accent';
  const label = d.action === 'UPDATE_EXIT' ? 'Exit updated' : d.action === 'BUY' ? 'Buy' : 'Sell';
  const outcome = d.outcome === 'filled' ? 'Executed' : d.outcome === 'queued' ? 'Queued' : d.outcome === 'updated' ? 'Updated' : 'Rejected';
  return (
    <Pressable onPress={() => nav.stock(`${d.symbol}.NS`)} style={{ gap: 4, paddingVertical: space.sm }} accessibilityRole="button">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Pill label={label} tone={tone} />
        <Txt v="bodyStrong">{d.symbol}</Txt>
        {d.qty ? (
          <Txt v="small" c="muted" num>
            × {d.qty}
            {d.price ? ` @ ${rupees(d.price)}` : ''}
          </Txt>
        ) : null}
        <View style={{ flex: 1 }} />
        <Pill label={outcome} tone={d.outcome === 'rejected' ? 'down' : 'neutral'} />
      </View>
      {d.stop || d.target ? (
        <Txt v="small" c="muted" num>
          {d.stop ? `SL ${rupees(d.stop)}` : ''}
          {d.stop && d.target ? ' · ' : ''}
          {d.target ? `Target ${rupees(d.target)}` : ''}
          {d.conviction ? ` · conviction ${d.conviction}/5` : ''}
        </Txt>
      ) : null}
      {d.rationale ? <Txt v="small">{d.rationale}</Txt> : null}
      {d.error ? (
        <Txt v="small" c="down">
          {d.error}
        </Txt>
      ) : null}
    </Pressable>
  );
}


const STEP_ICON: Record<AiStep['kind'], IconName> = {
  search: 'search',
  fetch: 'document-text-outline',
  tool: 'analytics-outline',
  order: 'swap-horizontal',
  note: 'information-circle-outline',
  error: 'alert-circle-outline',
};

export function StepRow({ step }: { step: AiStep }) {
  const p = usePalette();
  const color = step.kind === 'error' ? p.down : step.kind === 'order' ? p.accent : p.muted;
  return (
    <View style={{ flexDirection: 'row', gap: space.sm, paddingVertical: 6, alignItems: 'flex-start' }}>
      <Ionicons name={STEP_ICON[step.kind]} size={16} color={color} style={{ marginTop: 2 }} />
      <Txt v="small" c={step.kind === 'error' ? 'down' : 'text'} style={{ flex: 1 }}>
        {step.text}
      </Txt>
      <Txt v="small" c="faint" num>
        {formatIstTime(step.t, false)}
      </Txt>
    </View>
  );
}
