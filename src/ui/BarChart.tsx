import { useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Rect } from 'react-native-svg';

import { usePalette } from './theme';

/** Signed bars around a zero line, oldest on the left. */
export function PnlBars({ values, height = 96, highlight }: { values: number[]; height?: number; highlight?: number | null }) {
  const p = usePalette();
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));
  const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)));
  const n = Math.max(values.length, 1);
  const gap = n > 40 ? 1 : 3;
  const barW = width > 0 ? Math.min(18, Math.max(2, (width - gap * (n - 1)) / n)) : 0;
  const mid = height / 2;
  return (
    <View onLayout={onLayout} style={{ height, width: '100%' }}>
      {width > 0 ? (
        <Svg width={width} height={height}>
          <Line x1={0} x2={width} y1={mid} y2={mid} stroke={p.border} strokeWidth={1} />
          {values.map((v, i) => {
            const h = Math.max(1, (Math.abs(v) / maxAbs) * (mid - 4));
            const x = i * (barW + gap);
            const y = v >= 0 ? mid - h : mid;
            return (
              <Rect
                key={i}
                x={x}
                y={y}
                width={barW}
                height={h}
                rx={Math.min(2, barW / 2)}
                fill={v >= 0 ? p.up : p.down}
                opacity={highlight === null || highlight === undefined || highlight === i ? 1 : 0.45}
              />
            );
          })}
        </Svg>
      ) : null}
    </View>
  );
}
