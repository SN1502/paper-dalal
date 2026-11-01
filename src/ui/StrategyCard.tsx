import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { yahooCandles } from '../data/yahoo';
import type { Candle } from '../engine/types';
import { num, pct } from '../lib/format';
import { SESSION, formatDayKey, istDayKey, istParts } from '../lib/time';
import { channel, threeMaSignal, twoMaSignal } from '../strategies/scan';
import { ibs, knnForecast, pivots } from '../strategies/single';
import { useStrategies } from '../strategies/store';
import { Card, Divider, KeyValue, Pill, Txt } from './kit';
import { radius, space, usePalette } from './theme';

const cache = new Map<string, { at: number; candles: Candle[] }>();

function useDailyCandles(symbol: string) {
  const [candles, setCandles] = useState<Candle[] | null>(cache.get(symbol)?.candles ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const hit = cache.get(symbol);
    if (hit && Date.now() - hit.at < 30 * 60_000) {
      setCandles(hit.candles);
      return;
    }
    let alive = true;
    yahooCandles(symbol, '2y', '1d')
      .then((s) => {
        cache.set(symbol, { at: Date.now(), candles: s.candles });
        if (alive) setCandles(s.candles);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : 'Unavailable'));
    return () => {
      alive = false;
    };
  }, [symbol]);
  return { candles, error };
}

function Meter({ label, value }: { label: string; value: number | null }) {
  const p = usePalette();
  const v = value ?? 0;
  const color = value === null ? p.border : v >= 80 ? p.up : v >= 50 ? p.accent : v >= 20 ? p.warn : p.down;
  return (
    <View style={{ flex: 1, gap: 3 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Txt v="caption" c="faint" style={{ textTransform: 'none' }}>
          {label}
        </Txt>
        <Txt v="caption" c="muted" num>
          {value === null ? '—' : Math.round(v)}
        </Txt>
      </View>
      <View style={[styles.meter, { backgroundColor: p.surfaceAlt }]}>
        <View style={{ width: `${value === null ? 0 : Math.max(4, v)}%`, height: '100%', backgroundColor: color, borderRadius: radius.pill }} />
      </View>
    </View>
  );
}

/** The stock's signals from "151 Trading Strategies": its scan row plus single-stock rules. */
export function StrategyCard({ symbol, price }: { symbol: string; price: number | null }) {
  const st = useStrategies();
  const row = st.scan?.stocks.find((s) => s.symbol === symbol) ?? null;
  const fund = st.fundamentals[symbol];
  const { candles, error } = useDailyCandles(symbol);

  const single = useMemo(() => {
    if (!candles || candles.length < 30) return null;
    const now = Date.now();
    const last = candles[candles.length - 1];
    const partial = istDayKey(last.t) === istDayKey(now) && istParts(now).minuteOfDay < SESSION.close;
    const completed = partial ? candles.slice(0, -1) : candles;
    const closes = candles.map((c) => c.c);
    const p = price ?? last.c;
    return {
      pivots: pivots(completed, p),
      channel: channel(closes),
      ma2: twoMaSignal(closes),
      ma3: threeMaSignal(closes),
      ibs: ibs(completed),
      knn: knnForecast(candles, 10),
    };
  }, [candles, price]);

  const trend = [
    row?.aboveSma200 === true ? 'Above 200 DMA' : row?.aboveSma200 === false ? 'Below 200 DMA' : null,
    single?.ma2 ? `MA10 ${single.ma2 === 'up' ? '>' : '<'} MA30` : null,
    single?.ma3 ? `3-MA ${single.ma3}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Card style={{ gap: space.sm }}>
      <View style={styles.inline}>
        <Txt v="caption" c="muted" style={{ flex: 1 }}>
          Strategy signals · 151 Trading Strategies
        </Txt>
        {row?.decile ? <Pill label={`Decile ${row.decile}`} tone={row.decile >= 9 ? 'up' : row.decile <= 3 ? 'down' : 'neutral'} /> : null}
      </View>

      {row ? (
        <>
          <View style={styles.inline}>
            <Txt v="title" num>
              {row.pct.composite !== null ? Math.round(row.pct.composite) : '—'}
            </Txt>
            <Txt v="small" c="muted" style={{ flex: 1 }}>
              multifactor percentile (§3.6) among {st.scan?.covered ?? '—'} NSE stocks
            </Txt>
          </View>
          <View style={styles.meters}>
            <Meter label="MOM" value={row.pct.momentum} />
            <Meter label="RESID" value={row.pct.residualMomentum} />
            <Meter label="LOW σ" value={row.pct.lowVol} />
            <Meter label="SECTOR" value={row.pct.sector} />
          </View>
          {row.tags.length ? (
            <View style={styles.tags}>
              {row.tags.map((t) => (
                <Pill key={t} label={t} tone={t === 'Below 200 DMA' || t === 'At channel ceiling' ? 'warn' : t === 'Top decile' ? 'up' : 'neutral'} />
              ))}
            </View>
          ) : null}
          <Divider />
          <KeyValue label="12-1M momentum (§3.1)" value={row.mom12_1 !== null ? pct(row.mom12_1 * 100) : '—'} />
          <KeyValue label="Residual momentum (§3.7)" value={row.resMom !== null ? row.resMom.toFixed(2) : '—'} />
          <KeyValue label="Volatility, 1Y (§3.4)" value={row.vol !== null ? `${(row.vol * 100).toFixed(1)}%` : '—'} />
          <KeyValue
            label="Beta · alpha · R² (§4.2–4.3)"
            value={`${row.beta?.toFixed(2) ?? '—'} · ${row.alpha !== null ? pct(row.alpha * 100) : '—'} · ${row.r2?.toFixed(2) ?? '—'}`}
          />
          <KeyValue label="5D vs sector (§3.9.1)" value={row.rev5dDemeaned !== null ? pct(row.rev5dDemeaned * 100) : '—'} />
        </>
      ) : (
        <Txt v="small" c="muted">
          {st.scan ? 'This stock isn’t in the ranked universe, so it has no multifactor score.' : 'Open Strategy signals in the AI tab to run today’s scan.'}
        </Txt>
      )}

      <Divider />
      {single ? (
        <>
          {trend ? <KeyValue label="Trend (§3.11–3.13)" value={trend} /> : null}
          {single.pivots.daily ? (
            <KeyValue
              label="Daily pivot S · C · R (§3.14)"
              value={`${num(single.pivots.daily.support)} · ${num(single.pivots.daily.pivot)} · ${num(single.pivots.daily.resistance)}`}
            />
          ) : null}
          {single.pivots.weekly ? (
            <KeyValue
              label="Weekly pivot S · C · R"
              value={`${num(single.pivots.weekly.support)} · ${num(single.pivots.weekly.pivot)} · ${num(single.pivots.weekly.resistance)}`}
            />
          ) : null}
          {single.channel ? (
            <KeyValue
              label="20D channel (§3.15)"
              value={`${num(single.channel.low)}–${num(single.channel.high)} · ${Math.round(single.channel.position * 100)}%`}
            />
          ) : null}
          {single.ibs !== null ? <KeyValue label="IBS, last day (§4.4)" value={single.ibs.toFixed(2)} /> : null}
          {single.knn ? (
            <KeyValue
              label="KNN 10-day forecast (§3.17)"
              value={`${pct(single.knn.forecast * 100)} · hit ${Math.round(single.knn.cvHitRate * 100)}% vs ${Math.round(single.knn.cvUpShare * 100)}% up`}
            />
          ) : null}
        </>
      ) : error ? (
        <Txt v="small" c="muted">
          Single-stock signals unavailable: {error}
        </Txt>
      ) : (
        <ActivityIndicator />
      )}

      {fund ? (
        <>
          <Divider />
          <KeyValue label="Earnings momentum, SUE (§3.2)" value={fund.score.sue !== null ? `${fund.score.sue} (${fund.score.sueLabel})` : '—'} />
          <KeyValue label="Book-to-price (§3.3)" value={fund.score.bookToPrice !== null ? fund.score.bookToPrice.toFixed(3) : '—'} />
          <Txt v="small" c="faint">
            Scored by the AI on {formatDayKey(istDayKey(fund.at))}
            {fund.source ? ` from ${fund.source}` : ''}.
          </Txt>
        </>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  meter: { height: 4, borderRadius: radius.pill, overflow: 'hidden' },
  meters: { flexDirection: 'row', gap: space.md },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
