import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RANGE_INTERVAL, yahooCandles, type ChartRange } from '@/data/yahoo';
import { positionKey } from '@/engine/engine';
import { compactCount, num, pct, rupees, signedNum, signedRupees } from '@/lib/format';
import { SESSION, clockPhase, formatIstDateTime, formatIstTime, istDayKey, istParts, istTimestamp } from '@/lib/time';
import { controller } from '@/state/controller';
import { useEngine } from '@/state/engineStore';
import { useQuote } from '@/state/quoteStore';
import { Button, Card, IconButton, Pill, Screen, Segmented, Stat, TopBar, Txt } from '@/ui/kit';
import { LineChart, type ChartPoint } from '@/ui/LineChart';
import { useNav } from '@/ui/nav';
import { Change, LivePrice, changeOf } from '@/ui/Price';
import { space, toneOf, usePalette } from '@/ui/theme';

const RANGES: { value: ChartRange; label: string }[] = [
  { value: '1d', label: '1D' },
  { value: '5d', label: '1W' },
  { value: '1mo', label: '1M' },
  { value: '6mo', label: '6M' },
  { value: '1y', label: '1Y' },
  { value: '5y', label: '5Y' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function labelFor(range: ChartRange) {
  return (t: number) => {
    const d = istParts(t);
    if (range === '1d') return formatIstTime(t, false);
    if (range === '5y') return `${MONTHS[d.month - 1]} ${String(d.year).slice(2)}`;
    return `${d.day} ${MONTHS[d.month - 1]}`;
  };
}

export default function StockScreen() {
  const { symbol: rawSymbol } = useLocalSearchParams<{ symbol: string }>();
  const symbol = decodeURIComponent(String(rawSymbol ?? ''));
  const p = usePalette();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const state = useEngine();
  const inst = useMemo(() => controller.instrumentFor(symbol), [symbol]);
  const q = useQuote(symbol);

  const [range, setRange] = useState<ChartRange>('1d');
  const [points, setPoints] = useState<ChartPoint[]>([]);
  const [baseline, setBaseline] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [chartError, setChartError] = useState<string | null>(null);
  const [scrub, setScrub] = useState<ChartPoint | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  useEffect(() => controller.focusSymbol(inst), [inst]);

  useEffect(() => {
    if (q) return;
    const id = setTimeout(() => {
      if (!q) setQuoteError(`No price found for ${inst.tradingSymbol} on ${inst.exchange}. It may not be listed there.`);
    }, 9000);
    return () => clearTimeout(id);
  }, [q, inst]);

  const loadChart = useCallback(async () => {
    setLoading(true);
    setChartError(null);
    try {
      const s = await yahooCandles(symbol, range, RANGE_INTERVAL[range]);
      let candles = s.candles;
      if (range === '1d' && candles.length) {
        const day = istDayKey(candles[candles.length - 1].t);
        candles = candles.filter((c) => istDayKey(c.t) === day);
      }
      setPoints(candles.map((c) => ({ t: c.t, v: c.c })));
      setBaseline(range === '1d' ? s.prevClose : candles.length ? candles[0].c : null);
    } catch (e) {
      setPoints([]);
      setChartError(e instanceof Error ? e.message : 'Chart unavailable');
    } finally {
      setLoading(false);
    }
  }, [symbol, range]);

  useEffect(() => {
    void loadChart();
  }, [loadChart]);

  // Keep the intraday chart moving while the market is open.
  useEffect(() => {
    if (range !== '1d') return;
    const id = setInterval(() => {
      if (clockPhase(Date.now()) === 'open') void loadChart();
    }, 60_000);
    return () => clearInterval(id);
  }, [range, loadChart]);

  const xDomain = useMemo<[number, number] | undefined>(() => {
    if (range !== '1d' || points.length === 0) return undefined;
    const day = istDayKey(points[points.length - 1].t);
    return [istTimestamp(day, SESSION.open), istTimestamp(day, SESSION.close)];
  }, [range, points]);

  // Extend the 1D line to the live price between chart refreshes.
  const chartData = useMemo(() => {
    if (range !== '1d' || !q || points.length === 0) return points;
    const last = points[points.length - 1];
    if (q.time > last.t && istDayKey(q.time) === istDayKey(last.t)) return [...points, { t: q.time, v: q.ltp }];
    return points;
  }, [points, q, range]);

  const { change, changePct } = changeOf(q?.ltp, q?.prevClose);
  const lastV = chartData.length ? chartData[chartData.length - 1].v : null;
  const ref = baseline ?? (chartData.length ? chartData[0].v : null);
  const chartColor = lastV !== null && ref !== null && lastV < ref ? p.down : p.up;
  const formatX = useMemo(() => labelFor(range), [range]);

  const watched = state.watchlist.some((i) => i.symbol === symbol);
  const holding = state.holdings[symbol];
  const cnc = state.positions[positionKey(symbol, 'CNC')];
  const mis = state.positions[positionKey(symbol, 'MIS')];
  const ltp = q?.ltp ?? null;
  const live = q ? clockPhase(Date.now()) === 'open' && istDayKey(q.time) === istDayKey(Date.now()) : false;

  const scrubChange = scrub && ref !== null ? scrub.v - ref : null;

  return (
    <Screen>
      <TopBar
        back
        title={inst.tradingSymbol}
        subtitle={`${inst.name} · ${inst.isIndex ? 'Index' : inst.exchange}`}
        right={
          inst.isIndex ? null : (
            <IconButton
              name={watched ? 'bookmark' : 'bookmark-outline'}
              color={watched ? p.accent : p.text}
              label={watched ? 'Remove from watchlist' : 'Add to watchlist'}
              onPress={() => (watched ? controller.removeFromWatchlist(symbol) : controller.addToWatchlist(inst))}
            />
          )
        }
      />
      <ScrollView contentContainerStyle={{ paddingBottom: inst.isIndex ? space.xxl : 110 }}>
        <View style={styles.priceBlock}>
          {scrub ? (
            <>
              <Txt v="display" num>
                {num(scrub.v)}
              </Txt>
              <Txt v="small" c={toneOf(p, scrubChange)} num>
                {signedNum(scrubChange)} ({pct(ref ? ((scrub.v - ref) / ref) * 100 : null)}) · {range === '1d' ? formatIstTime(scrub.t, false) : formatIstDateTime(scrub.t)}
              </Txt>
            </>
          ) : (
            <>
              <LivePrice value={ltp} v="display" align="left" />
              <Change change={change} changePct={changePct} v="bodyStrong" align="left" />
              <Txt v="small" c="faint">
                {q
                  ? `${live ? 'Live' : 'Last traded'} ${formatIstDateTime(q.time || q.fetchedAt)} IST · ${q.source === 'google' ? 'Google Finance' : 'Yahoo Finance'}`
                  : quoteError ?? 'Fetching price…'}
              </Txt>
            </>
          )}
        </View>

        <View style={{ paddingHorizontal: space.lg }}>
          <View style={styles.chartBox}>
            {loading && chartData.length === 0 ? (
              <ActivityIndicator color={p.accent} />
            ) : chartError ? (
              <View style={{ alignItems: 'center', gap: space.sm }}>
                <Txt v="small" c="muted" align="center">
                  Chart unavailable: {chartError}
                </Txt>
                <Button label="Try again" variant="ghost" compact onPress={() => void loadChart()} />
              </View>
            ) : chartData.length < 2 ? (
              <Txt v="small" c="muted">
                Not enough data for this range yet.
              </Txt>
            ) : (
              <LineChart data={chartData} color={chartColor} baseline={range === '1d' ? baseline : null} xDomain={xDomain} formatX={formatX} onScrub={setScrub} height={230} />
            )}
          </View>
          <Segmented options={RANGES} value={range} onChange={setRange} size="sm" />
        </View>

        <Card style={{ marginHorizontal: space.lg, marginTop: space.lg }}>
          <View style={styles.grid}>
            <View style={styles.cell}>
              <Stat label="Open" value={num(q?.open)} />
            </View>
            <View style={styles.cell}>
              <Stat label="High" value={num(q?.high)} />
            </View>
            <View style={styles.cell}>
              <Stat label="Low" value={num(q?.low)} />
            </View>
            <View style={styles.cell}>
              <Stat label="Prev close" value={num(q?.prevClose)} />
            </View>
            <View style={styles.cell}>
              <Stat label="Volume" value={compactCount(q?.volume)} />
            </View>
            <View style={styles.cell}>
              <Stat label="52W range" value={q?.week52Low && q?.week52High ? `${num(q.week52Low, 0)}–${num(q.week52High, 0)}` : '—'} />
            </View>
          </View>
        </Card>

        {holding || (cnc && cnc.netQty !== 0) || (mis && (mis.netQty !== 0 || mis.realizedPnl !== 0)) ? (
          <Card style={{ marginHorizontal: space.lg, marginTop: space.md, gap: space.md }}>
            <Txt v="caption" c="muted">
              Your position
            </Txt>
            {holding ? (
              <PositionLine
                tag="Holding"
                qty={holding.qty}
                avg={holding.avgPrice}
                pnl={ltp !== null ? holding.qty * (ltp - holding.avgPrice) : null}
              />
            ) : null}
            {cnc && cnc.netQty !== 0 ? (
              <PositionLine tag="Delivery today" qty={cnc.netQty} avg={cnc.avgPrice} pnl={ltp !== null ? cnc.realizedPnl + cnc.netQty * (ltp - cnc.avgPrice) : null} />
            ) : null}
            {mis && (mis.netQty !== 0 || mis.realizedPnl !== 0) ? (
              <PositionLine
                tag="Intraday"
                qty={mis.netQty}
                avg={mis.avgPrice}
                pnl={ltp !== null ? mis.realizedPnl + (mis.netQty !== 0 ? mis.netQty * (ltp - mis.avgPrice) : 0) : mis.realizedPnl}
              />
            ) : null}
          </Card>
        ) : null}

        {inst.isIndex ? (
          <Txt v="small" c="muted" style={{ padding: space.lg }}>
            Indices can’t be traded directly. Try an index ETF such as NIFTYBEES or BANKBEES.
          </Txt>
        ) : null}
      </ScrollView>

      {!inst.isIndex ? (
        <View style={[styles.bottomBar, { backgroundColor: p.surface, borderTopColor: p.border, paddingBottom: Math.max(insets.bottom, space.md) }]}>
          <Button label="Sell" variant="sell" style={{ flex: 1 }} onPress={() => nav.order({ symbol, side: 'SELL' })} />
          <Button label="Buy" variant="buy" style={{ flex: 1 }} onPress={() => nav.order({ symbol, side: 'BUY' })} />
        </View>
      ) : null}
    </Screen>
  );
}

function PositionLine({ tag, qty, avg, pnl }: { tag: string; qty: number; avg: number; pnl: number | null }) {
  const p = usePalette();
  return (
    <View style={styles.posLine}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Pill label={tag} tone={qty < 0 ? 'sell' : 'accent'} />
        <Txt v="small" c="muted" num>
          {qty !== 0 ? `${qty > 0 ? '' : 'Short '}${Math.abs(qty)} @ ${rupees(avg)}` : 'Closed today'}
        </Txt>
      </View>
      <Txt v="bodyStrong" num c={toneOf(p, pnl)}>
        {signedRupees(pnl)}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  priceBlock: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: 2, minHeight: 92 },
  chartBox: { height: 240, justifyContent: 'center', alignItems: 'center', marginBottom: space.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: space.lg },
  cell: { width: '33.33%', paddingRight: space.sm },
  posLine: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
