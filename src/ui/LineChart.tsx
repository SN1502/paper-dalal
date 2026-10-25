import { useMemo, useRef, useState } from 'react';
import { PanResponder, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Stop, Text as SvgText } from 'react-native-svg';

import { num } from '../lib/format';
import { usePalette } from './theme';

export interface ChartPoint {
  t: number;
  v: number;
}

function niceStep(raw: number): number {
  if (raw <= 0 || !Number.isFinite(raw)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const nice = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
  return nice * pow;
}

function nearestByTime(data: ChartPoint[], t: number): number {
  let lo = 0;
  let hi = data.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (data[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(data[lo - 1].t - t) < Math.abs(data[lo].t - t)) return lo - 1;
  return lo;
}

const PAD = { top: 14, bottom: 24, right: 58 };

export function LineChart({
  data,
  height = 220,
  color,
  baseline,
  xDomain,
  formatX,
  onScrub,
}: {
  data: ChartPoint[];
  height?: number;
  color: string;
  /** Dashed reference line, e.g. previous close. */
  baseline?: number | null;
  /** Fixed time axis (used for the 1-day view so the session always spans the width). */
  xDomain?: [number, number];
  formatX: (t: number) => string;
  onScrub?: (p: ChartPoint | null) => void;
}) {
  const p = usePalette();
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);

  const geo = useMemo(() => {
    if (width <= 0 || data.length < 2) return null;
    const innerW = width - PAD.right;
    const innerH = height - PAD.top - PAD.bottom;
    let min = Infinity;
    let max = -Infinity;
    for (const d of data) {
      if (d.v < min) min = d.v;
      if (d.v > max) max = d.v;
    }
    if (baseline !== null && baseline !== undefined) {
      min = Math.min(min, baseline);
      max = Math.max(max, baseline);
    }
    if (max - min < 1e-9) {
      max += Math.max(1, max * 0.005);
      min -= Math.max(1, min * 0.005);
    }
    const span = max - min;
    min -= span * 0.08;
    max += span * 0.08;

    const [t0, t1] = xDomain ?? [data[0].t, data[data.length - 1].t];
    const xOf = (i: number) =>
      xDomain ? ((data[i].t - t0) / Math.max(1, t1 - t0)) * innerW : (i / (data.length - 1)) * innerW;
    const yOf = (v: number) => PAD.top + ((max - v) / (max - min)) * innerH;

    let line = '';
    for (let i = 0; i < data.length; i++) line += `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)} ${yOf(data[i].v).toFixed(1)}`;
    const bottom = PAD.top + innerH;
    const area = `${line}L${xOf(data.length - 1).toFixed(1)} ${bottom}L${xOf(0).toFixed(1)} ${bottom}Z`;

    const step = niceStep((max - min) / 4);
    const ticks: number[] = [];
    for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(v);

    const xLabels: { x: number; label: string }[] = [];
    const count = innerW < 260 ? 3 : 4;
    for (let k = 0; k < count; k++) {
      const frac = k / (count - 1);
      if (xDomain) xLabels.push({ x: frac * innerW, label: formatX(t0 + frac * (t1 - t0)) });
      else {
        const idx = Math.round(frac * (data.length - 1));
        xLabels.push({ x: xOf(idx), label: formatX(data[idx].t) });
      }
    }
    return { innerW, innerH, xOf, yOf, line, area, ticks, xLabels, t0, t1, bottom };
  }, [width, height, data, baseline, xDomain, formatX]);

  const latest = useRef({ geo, data, xDomain, onScrub });
  latest.current = { geo, data, xDomain, onScrub };

  const pick = (x: number) => {
    const { geo: g, data: d, xDomain: dom, onScrub: cb } = latest.current;
    if (!g || d.length === 0) return;
    const clamped = Math.max(0, Math.min(g.innerW, x));
    const idx = dom
      ? nearestByTime(d, g.t0 + (clamped / g.innerW) * (g.t1 - g.t0))
      : Math.round((clamped / g.innerW) * (d.length - 1));
    setCursor(idx);
    cb?.(d[idx]);
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => pick(e.nativeEvent.locationX),
      onPanResponderMove: (e) => pick(e.nativeEvent.locationX),
      onPanResponderRelease: () => {
        setCursor(null);
        latest.current.onScrub?.(null);
      },
      onPanResponderTerminate: () => {
        setCursor(null);
        latest.current.onScrub?.(null);
      },
    }),
  ).current;

  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));
  const lastIdx = data.length - 1;
  const active = cursor !== null && cursor <= lastIdx ? cursor : null;

  return (
    <View onLayout={onLayout} style={{ height, width: '100%' }} {...responder.panHandlers} accessibilityLabel="Price chart. Drag to inspect prices.">
      {geo ? (
        <Svg width={width} height={height}>
          <Defs>
            <LinearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={color} stopOpacity={0.22} />
              <Stop offset="1" stopColor={color} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          {geo.ticks.map((v) => (
            <Line key={`g${v}`} x1={0} x2={geo.innerW} y1={geo.yOf(v)} y2={geo.yOf(v)} stroke={p.border} strokeWidth={1} />
          ))}
          {geo.ticks.map((v) => (
            <SvgText key={`l${v}`} x={geo.innerW + 6} y={geo.yOf(v) + 4} fontSize={10} fill={p.faint}>
              {num(v, v >= 1000 ? 0 : 2)}
            </SvgText>
          ))}
          {baseline !== null && baseline !== undefined ? (
            <Line
              x1={0}
              x2={geo.innerW}
              y1={geo.yOf(baseline)}
              y2={geo.yOf(baseline)}
              stroke={p.muted}
              strokeWidth={1}
              strokeDasharray="3 4"
            />
          ) : null}
          <Path d={geo.area} fill="url(#fill)" />
          <Path d={geo.line} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
          {geo.xLabels.map((l, i) => (
            <SvgText
              key={`x${i}`}
              x={l.x}
              y={geo.bottom + 16}
              fontSize={10}
              fill={p.faint}
              textAnchor={i === 0 ? 'start' : i === geo.xLabels.length - 1 ? 'end' : 'middle'}
            >
              {l.label}
            </SvgText>
          ))}
          {active !== null ? (
            <>
              <Line x1={geo.xOf(active)} x2={geo.xOf(active)} y1={PAD.top} y2={geo.bottom} stroke={p.muted} strokeWidth={1} />
              <Circle cx={geo.xOf(active)} cy={geo.yOf(data[active].v)} r={5} fill={color} stroke={p.surface} strokeWidth={2} />
            </>
          ) : (
            <Circle cx={geo.xOf(lastIdx)} cy={geo.yOf(data[lastIdx].v)} r={4} fill={color} stroke={p.surface} strokeWidth={2} />
          )}
        </Svg>
      ) : null}
    </View>
  );
}
