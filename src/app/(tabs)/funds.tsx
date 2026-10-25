import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { accountSummary } from '@/engine/selectors';
import type { Settings } from '@/engine/types';
import { compactRupees, pct, rupees, signedRupees } from '@/lib/format';
import { formatAge, formatDayKey, formatHHMM, istDayKey, parseHHMM } from '@/lib/time';
import { controller } from '@/state/controller';
import { engineStore, useEngine } from '@/state/engineStore';
import { useQuotes } from '@/state/quoteStore';
import { useFeedStatus } from '@/state/uiStores';
import { PnlBars } from '@/ui/BarChart';
import { Button, Card, Divider, KeyValue, Screen, Segmented, Stat, TopBar, Txt } from '@/ui/kit';
import { FeedLine } from '@/ui/MarketPill';
import { ConfirmSheet } from '@/ui/Sheet';
import { space, toneOf, usePalette } from '@/ui/theme';

const CAPITALS = [100_000, 500_000, 1_000_000, 2_500_000];

function SettingRow<T extends string>({
  label,
  help,
  options,
  value,
  onChange,
}: {
  label: string;
  help: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={{ gap: space.sm }}>
      <View>
        <Txt v="bodyStrong">{label}</Txt>
        <Txt v="small" c="muted">
          {help}
        </Txt>
      </View>
      <Segmented options={options} value={value} onChange={onChange} size="sm" />
    </View>
  );
}

export default function FundsScreen() {
  const p = usePalette();
  const state = useEngine();
  const quotes = useQuotes();
  const feed = useFeedStatus();
  const s = useMemo(() => accountSummary(state, quotes), [state, quotes]);
  const [capital, setCapital] = useState(String(state.settings.startingCapital));
  const [confirmReset, setConfirmReset] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const days = useMemo(() => {
    const past = [...state.dayLog].slice(0, 29).reverse();
    const todayRealized = state.fills.filter((f) => f.tradingDay === state.tradingDay).reduce((a, f) => a + f.realizedPnl - f.charges.total, 0);
    const series = past.map((d) => ({ day: d.day, v: d.realizedPnl - d.charges }));
    if (s.fillsToday > 0) series.push({ day: state.tradingDay, v: todayRealized });
    return series;
  }, [state.dayLog, state.fills, state.tradingDay, s.fillsToday]);

  const dayStats = useMemo(() => {
    if (days.length === 0) return null;
    const wins = days.filter((d) => d.v > 0).length;
    const best = days.reduce((a, b) => (b.v > a.v ? b : a));
    const worst = days.reduce((a, b) => (b.v < a.v ? b : a));
    return { wins, total: days.length, best, worst };
  }, [days]);

  const set = (patch: Partial<Settings>) => controller.updateSettings(patch);

  return (
    <Screen>
      <TopBar title="Funds" large />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md }}>
        <Card style={{ gap: space.sm }}>
          <Txt v="caption" c="muted">
            Account value
          </Txt>
          <Txt v="display" num>
            {rupees(s.equity)}
          </Txt>
          <Txt v="bodyStrong" num c={toneOf(p, s.netPnl)}>
            {signedRupees(s.netPnl)} ({pct(s.netPnlPct)}) since start
          </Txt>
          <Txt v="small" c="faint">
            Started with {rupees(s.startingCapital, 0)} on {formatDayKey(istDayKey(state.account.createdAt))}
          </Txt>
        </Card>

        <Card style={{ gap: space.md }}>
          <View style={styles.pair}>
            <Stat label="Available to trade" value={rupees(s.available)} />
            <Stat label="Today’s P&L" value={signedRupees(s.dayPnl)} tone={toneOf(p, s.dayPnl)} align="right" />
          </View>
          <Divider />
          <View>
            <KeyValue label="Cash balance" value={rupees(s.cash)} />
            <KeyValue label="Intraday margin in use" value={rupees(s.misMargin)} />
            <KeyValue label="Reserved by open orders" value={rupees(s.orderBlocks)} />
            <KeyValue label="Intraday open P&L" value={signedRupees(s.misUnrealized)} tone={toneOf(p, s.misUnrealized)} />
            <KeyValue label="Holdings value" value={rupees(s.holdingsValue)} />
            <KeyValue label="Today’s delivery buys" value={rupees(s.cncPositionsValue)} />
            <Divider />
            <KeyValue label="Booked P&L (all time)" value={signedRupees(s.realizedPnl)} tone={toneOf(p, s.realizedPnl)} />
            <KeyValue label="Charges paid (all time)" value={rupees(s.chargesPaid)} />
          </View>
        </Card>

        <Card style={{ gap: space.md }}>
          <View style={styles.pair}>
            <Txt v="caption" c="muted">
              Daily P&L
            </Txt>
            {days.length ? (
              <Txt v="small" c="faint">
                After charges · last {days.length} day{days.length === 1 ? '' : 's'}
              </Txt>
            ) : null}
          </View>
          {days.length ? (
            <>
              <PnlBars values={days.map((d) => d.v)} />
              {dayStats ? (
                <View style={styles.pair}>
                  <Stat label="Green days" value={`${dayStats.wins} of ${dayStats.total}`} />
                  <Stat label="Best" value={compactRupees(dayStats.best.v)} tone={toneOf(p, dayStats.best.v)} align="right" />
                  <Stat label="Worst" value={compactRupees(dayStats.worst.v)} tone={toneOf(p, dayStats.worst.v)} align="right" />
                </View>
              ) : null}
            </>
          ) : (
            <Txt v="small" c="muted">
              Your daily results build up here once you start trading.
            </Txt>
          )}
        </Card>

        <Card style={{ gap: space.lg }}>
          <Txt v="caption" c="muted">
            Trading rules
          </Txt>
          <SettingRow
            label="Intraday leverage"
            help="How much exposure each rupee of margin buys on MIS orders."
            options={[
              { value: '1', label: '1x' },
              { value: '2', label: '2x' },
              { value: '3', label: '3x' },
              { value: '5', label: '5x' },
            ]}
            value={String(state.settings.misLeverage) as '1' | '2' | '3' | '5'}
            onChange={(v) => set({ misLeverage: Number(v) })}
          />
          <SettingRow
            label="Intraday square-off"
            help={`Open MIS positions are closed at ${formatHHMM(parseHHMM(state.settings.squareOffTime))}.`}
            options={[
              { value: '15:15', label: '3:15' },
              { value: '15:20', label: '3:20' },
              { value: '15:25', label: '3:25' },
            ]}
            value={state.settings.squareOffTime as '15:15' | '15:20' | '15:25'}
            onChange={(v) => set({ squareOffTime: v })}
          />
          <SettingRow
            label="Market order slippage"
            help="Makes market and SL-M fills slightly worse than the last price, as in real trading."
            options={[
              { value: '0', label: 'None' },
              { value: '5', label: '0.05%' },
              { value: '10', label: '0.10%' },
              { value: '25', label: '0.25%' },
            ]}
            value={String(state.settings.slippageBps) as '0' | '5' | '10' | '25'}
            onChange={(v) => set({ slippageBps: Number(v) })}
          />
          <SettingRow
            label="Price refresh"
            help="How often prices update while the market is open. Faster uses more data."
            options={[
              { value: '3', label: '3s' },
              { value: '5', label: '5s' },
              { value: '10', label: '10s' },
              { value: '15', label: '15s' },
            ]}
            value={String(state.settings.refreshSeconds) as '3' | '5' | '10' | '15'}
            onChange={(v) => set({ refreshSeconds: Number(v) })}
          />
        </Card>

        <Card style={{ gap: space.md }}>
          <Txt v="caption" c="muted">
            Price feed
          </Txt>
          <FeedLine />
          {feed.failing.length ? (
            <Txt v="small" c="warn">
              No price for {feed.failing.length} symbol{feed.failing.length > 1 ? 's' : ''}: {feed.failing.slice(0, 4).join(', ')}
              {feed.failing.length > 4 ? '…' : ''}
            </Txt>
          ) : null}
          {feed.lastAttemptAt ? (
            <Txt v="small" c="faint">
              Last check {formatAge(feed.lastAttemptAt)} ago
            </Txt>
          ) : null}
          {engineStore.lastSaveError() ? (
            <Txt v="small" c="down">
              Saving failed: {engineStore.lastSaveError()}
            </Txt>
          ) : null}
          <Button
            label="Refresh prices now"
            variant="secondary"
            compact
            loading={refreshing}
            onPress={async () => {
              setRefreshing(true);
              await controller.refresh();
              setRefreshing(false);
            }}
          />
        </Card>

        <Card style={{ gap: space.md }}>
          <Txt v="caption" c="muted">
            Start over
          </Txt>
          <Txt v="small" c="muted">
            Clears positions, holdings, orders and history, and starts again with the capital you pick. Your watchlist stays.
          </Txt>
          <Segmented
            options={CAPITALS.map((c) => ({ value: String(c), label: compactRupees(c).replace('.00', '') }))}
            value={capital}
            onChange={setCapital}
            size="sm"
          />
          <Button label="Reset account" variant="danger" onPress={() => setConfirmReset(true)} />
        </Card>

        <Txt v="small" c="faint" style={{ paddingHorizontal: space.xs }}>
          PaperDalal is a simulator. No real orders are placed and no money moves. Prices come from Yahoo Finance’s public
          endpoints (Google Finance as a fallback) and may occasionally lag the exchange. Charges follow a typical discount
          broker’s equity schedule: zero delivery brokerage, 0.03% or ₹20 intraday, plus STT, exchange, SEBI, stamp duty and
          GST.
        </Txt>
      </ScrollView>
      <ConfirmSheet
        visible={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset your paper account?"
        body={`Everything except your watchlist is cleared and you restart with ${rupees(Number(capital), 0)}. This can’t be undone.`}
        confirmLabel="Reset"
        destructive
        onConfirm={() => controller.resetAccount(Number(capital))}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  pair: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.md },
});
