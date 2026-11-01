import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { aiStore } from '@/ai/store';
import { pct } from '@/lib/format';
import { formatDayKey, formatIstDateTime } from '@/lib/time';
import type { StockSignal } from '@/strategies/scan';
import { strategyStore, useStrategies } from '@/strategies/store';
import { Button, Card, Divider, Empty, IconButton, Pill, Screen, Segmented, TopBar, Txt, type PillTone } from '@/ui/kit';
import { useNav } from '@/ui/nav';
import { radius, space, toneOf, usePalette } from '@/ui/theme';

type View_ = 'top' | 'pullbacks' | 'momentum' | 'lowvol';

const REGIME: Record<string, [string, PillTone, string]> = {
  'risk-on': ['Risk-on', 'up', 'The Nifty 50 is above its 100- and 200-day averages. Momentum strategies are favoured.'],
  mixed: ['Mixed', 'warn', 'The Nifty 50 is between its 100- and 200-day averages. Be selective.'],
  'risk-off': ['Risk-off', 'down', 'The Nifty 50 is below both averages. Dual momentum rotates out of stocks into gold.'],
};

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

function StockRow({ s, rank, fundamentals, onPress }: { s: StockSignal; rank: number; fundamentals: string | null; onPress: () => void }) {
  const p = usePalette();
  const comp = s.pct.composite;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.stockRow, { backgroundColor: pressed ? p.surfaceAlt : p.surface }]} accessibilityRole="button">
      <View style={styles.rowTop}>
        <Txt v="small" c="faint" num style={{ width: 24 }}>
          {rank}
        </Txt>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Txt v="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
              {s.tradingSymbol}
            </Txt>
            <Txt v="caption" c="faint" numberOfLines={1}>
              {s.sector}
            </Txt>
          </View>
          <Txt v="small" c="muted" num numberOfLines={1}>
            ₹{s.price.toLocaleString('en-IN')} · 12-1M {s.mom12_1 !== null ? pct(s.mom12_1 * 100) : '—'} · vol{' '}
            {s.vol !== null ? `${Math.round(s.vol * 100)}%` : '—'}
          </Txt>
        </View>
        <View style={[styles.score, { backgroundColor: (comp ?? 0) >= 90 ? p.upSoft : p.surfaceAlt }]}>
          <Txt v="heading" num c={(comp ?? 0) >= 90 ? p.up : p.text}>
            {comp === null ? '—' : Math.round(comp)}
          </Txt>
        </View>
      </View>
      <View style={styles.meters}>
        <Meter label="MOM" value={s.pct.momentum} />
        <Meter label="RESID" value={s.pct.residualMomentum} />
        <Meter label="LOW σ" value={s.pct.lowVol} />
        <Meter label="SECTOR" value={s.pct.sector} />
      </View>
      {s.tags.length || fundamentals ? (
        <View style={styles.tags}>
          {fundamentals ? <Pill label={fundamentals} tone="accent" /> : null}
          {s.tags.slice(0, 3).map((t) => (
            <Pill key={t} label={t} tone={t === 'Below 200 DMA' || t === 'At channel ceiling' ? 'warn' : t === 'Top decile' ? 'up' : 'neutral'} />
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

export default function SignalsScreen() {
  const p = usePalette();
  const nav = useNav();
  const st = useStrategies();
  const [view, setView] = useState<View_>('top');
  const [sector, setSector] = useState<string | null>(null);

  useEffect(() => {
    void strategyStore.ensureFresh();
  }, []);

  const scan = st.scan;
  const rows = useMemo(() => {
    if (!scan) return [];
    let list = scan.stocks.filter((s) => s.pct.composite !== null);
    if (sector) list = list.filter((s) => s.sector === sector);
    if (view === 'pullbacks') list = list.filter((s) => (s.pct.composite ?? 0) >= 60 && (s.pct.reversal ?? 0) >= 80 && s.aboveSma200 !== false);
    if (view === 'momentum') list = [...list].sort((a, b) => (b.pct.momentum ?? -1) - (a.pct.momentum ?? -1));
    if (view === 'lowvol') list = [...list].sort((a, b) => (b.pct.lowVol ?? -1) - (a.pct.lowVol ?? -1));
    return list;
  }, [scan, view, sector]);

  const regime = scan?.regime ?? null;
  const filterOn = aiStore.get().settings.regimeFilter;

  const header = (
    <View style={{ gap: space.md, paddingBottom: space.sm }}>
      {st.status === 'loading' ? (
        <Card style={{ gap: space.sm }}>
          <Txt v="small" c="muted">
            Scanning {st.progress?.done ?? 0} of {st.progress?.total ?? '…'} stocks…
          </Txt>
          <View style={[styles.meter, { backgroundColor: p.surfaceAlt }]}>
            <View
              style={{
                width: `${st.progress ? Math.round((st.progress.done / Math.max(1, st.progress.total)) * 100) : 5}%`,
                height: '100%',
                backgroundColor: p.accent,
                borderRadius: radius.pill,
              }}
            />
          </View>
        </Card>
      ) : null}
      {st.error ? (
        <Txt v="small" c="down">
          {st.error}
        </Txt>
      ) : null}

      {regime ? (
        <Card style={{ gap: space.sm }}>
          <View style={styles.inline}>
            <Txt v="caption" c="muted" style={{ flex: 1 }}>
              Market regime · dual momentum §4.1.2
            </Txt>
            <Pill label={REGIME[regime.state][0]} tone={REGIME[regime.state][1]} />
          </View>
          <Txt v="small">{REGIME[regime.state][2]}</Txt>
          <Txt v="small" c="muted" num>
            Nifty {regime.close.toLocaleString('en-IN')} · 100-day {regime.sma100?.toLocaleString('en-IN') ?? '—'} · 200-day{' '}
            {regime.sma200?.toLocaleString('en-IN') ?? '—'} · 6M {regime.ret6m !== null ? pct(regime.ret6m * 100) : '—'}
          </Txt>
          {regime.state === 'risk-off' ? (
            <Txt v="small" c={filterOn ? 'down' : 'warn'}>
              {filterOn ? 'The AI only buys gold or silver ETFs until this clears.' : 'The market filter is off in AI settings.'}
            </Txt>
          ) : null}
        </Card>
      ) : null}

      {scan ? (
        <Card padded={false}>
          <View style={[styles.inline, { padding: space.lg, paddingBottom: space.sm }]}>
            <Txt v="caption" c="muted" style={{ flex: 1 }}>
              Sector momentum rotation · §4.1
            </Txt>
            <Txt v="caption" c="faint">
              6M · 12M · MA100
            </Txt>
          </View>
          {scan.sectors.map((s, i) => (
            <View key={s.sector}>
              {i > 0 ? <Divider inset={space.lg} /> : null}
              <Pressable
                onPress={() => setSector(sector === s.sector ? null : s.sector)}
                style={({ pressed }) => [styles.sectorRow, (pressed || sector === s.sector) && { backgroundColor: p.surfaceAlt }]}
                accessibilityRole="button"
                accessibilityState={{ selected: sector === s.sector }}
              >
                <Txt v="small" c="faint" num style={{ width: 22 }}>
                  {s.rank}
                </Txt>
                <Txt v="small" style={{ flex: 1 }} numberOfLines={1}>
                  {s.sector}{' '}
                  <Txt v="small" c="faint">
                    ({s.members})
                  </Txt>
                </Txt>
                <Txt v="smallStrong" num c={toneOf(p, s.ret6m)} style={styles.sectorNum}>
                  {s.ret6m !== null ? pct(s.ret6m * 100) : '—'}
                </Txt>
                <Txt v="small" num c={toneOf(p, s.ret12m)} style={styles.sectorNum}>
                  {s.ret12m !== null ? pct(s.ret12m * 100) : '—'}
                </Txt>
                <View style={[styles.dot, { backgroundColor: s.aboveMa100 === null ? p.border : s.aboveMa100 ? p.up : p.down }]} />
              </Pressable>
            </View>
          ))}
        </Card>
      ) : null}

      {scan ? (
        <View style={{ gap: space.sm }}>
          <Txt v="caption" c="muted">
            Multifactor ranking · §3.6
          </Txt>
          <Segmented
            size="sm"
            options={[
              { value: 'top', label: 'Top ranked' },
              { value: 'pullbacks', label: 'Pullbacks' },
              { value: 'momentum', label: 'Momentum' },
              { value: 'lowvol', label: 'Low vol' },
            ]}
            value={view}
            onChange={setView}
          />
          {sector ? (
            <Pressable onPress={() => setSector(null)} accessibilityRole="button">
              <Txt v="small" c="accent">
                Showing {sector} only · show all sectors
              </Txt>
            </Pressable>
          ) : null}
          <Txt v="small" c="faint">
            Score = average rank of momentum (§3.1), residual momentum (§3.7), low volatility (§3.4) and sector momentum (§4.1), as a
            percentile. 100 is best.
            {view === 'pullbacks' ? ' Pullbacks: ranked 60+ but down against their sector over 5 days (§3.9.1).' : ''}
          </Txt>
        </View>
      ) : null}
    </View>
  );

  const fundLabel = (sym: string) => {
    const f = st.fundamentals[sym];
    if (!f) return null;
    const parts = [f.score.sue !== null ? `SUE ${f.score.sue}` : null, f.score.bookToPrice !== null ? `B/P ${f.score.bookToPrice}` : null].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  };

  return (
    <Screen>
      <TopBar
        back
        title="Strategy signals"
        subtitle={scan ? `151 Trading Strategies · data to ${formatDayKey(scan.asOfDay)}` : '151 Trading Strategies'}
        right={<IconButton name="refresh" label="Rescan" onPress={() => void strategyStore.ensureFresh(true)} />}
      />
      {!scan && st.status !== 'loading' ? (
        <View style={{ padding: space.lg }}>
          <Empty
            icon="analytics-outline"
            title="No scan yet"
            body="The app downloads two years of daily prices for about 130 NSE stocks and ranks them with the paper’s strategies. It takes under a minute."
            action={<Button label="Run the scan" onPress={() => void strategyStore.ensureFresh(true)} />}
          />
          {st.error ? (
            <Txt v="small" c="down" align="center">
              {st.error}
            </Txt>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(s) => s.symbol}
          ListHeaderComponent={header}
          ListHeaderComponentStyle={{ paddingHorizontal: space.lg }}
          renderItem={({ item, index }) => (
            <StockRow s={item} rank={index + 1} fundamentals={fundLabel(item.symbol)} onPress={() => nav.stock(item.symbol)} />
          )}
          ItemSeparatorComponent={() => <Divider inset={space.lg} />}
          ListEmptyComponent={
            scan ? (
              <Txt v="small" c="muted" style={{ padding: space.lg }}>
                No stocks match this view right now.
              </Txt>
            ) : undefined
          }
          ListFooterComponent={
            scan ? (
              <View style={{ padding: space.lg, gap: space.sm }}>
                <Txt v="caption" c="muted">
                  Method
                </Txt>
                <Txt v="small" c="muted">
                  Kakushadze &amp; Serur, “151 Trading Strategies” (2018), applied long-only to daily NSE prices. Used: §3.1 price
                  momentum (12 months, skipping the latest month), §3.4 low volatility (1-year σ), §3.7 residual momentum (Nifty 50 as
                  the market factor instead of the Fama-French factors), §3.6 rank-based multifactor, §3.9.1 sector mean reversion,
                  §3.11–3.13 moving-average signals, §3.14 pivots, §3.15 channels, §3.17 KNN, §4.1–4.1.2 sector rotation and dual
                  momentum, §4.2–4.3 alpha and R², §4.4 IBS. §3.2 earnings momentum and §3.3 value are scored by the AI from
                  published fundamentals.
                </Txt>
                <Txt v="small" c="faint">
                  Not used, because they need short selling, options or intraday market access: §3.5 implied volatility, short legs
                  of §3.8 pairs, §3.18 dollar-neutral optimisation, §3.19 market-making, §3.20 alpha combos.
                </Txt>
                <Txt v="small" c="faint">
                  Computed {formatIstDateTime(scan.computedAt)} IST · {scan.covered} of {scan.universeSize} stocks ranked.
                </Txt>
              </View>
            ) : undefined
          }
          contentContainerStyle={{ paddingBottom: space.xxl }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  meter: { height: 4, borderRadius: radius.pill, overflow: 'hidden' },
  stockRow: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  score: { minWidth: 46, paddingHorizontal: 8, paddingVertical: 6, borderRadius: radius.md, alignItems: 'center' },
  meters: { flexDirection: 'row', gap: space.md, paddingLeft: 32 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingLeft: 32 },
  sectorRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: 10 },
  sectorNum: { width: 64, textAlign: 'right' },
  dot: { width: 8, height: 8, borderRadius: 4, marginLeft: space.sm },
});
