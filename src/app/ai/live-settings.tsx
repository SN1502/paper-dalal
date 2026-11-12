import { ScrollView } from 'react-native';

import { MODELS, type ModelId } from '@/ai/claude';
import { liveStore, useLive } from '@/live/store';
import type { LiveSettings } from '@/live/risk';
import { Button, Card, Screen, TopBar, Txt } from '@/ui/kit';
import { Choice, Toggle } from '@/ui/SettingsParts';
import { space } from '@/ui/theme';

/** Rough cost of one live decision (a short call with a cached system prompt). */
function perDecision(model: ModelId): string {
  const m = MODELS[model];
  const usd = (14_000 * m.input + 9_000 * m.cacheRead + 1_500 * m.cacheWrite + 900 * m.output) / 1e6;
  return usd < 0.01 ? 'under 1 cent' : `about $${usd.toFixed(2)}`;
}

export default function LiveSettingsScreen() {
  const live = useLive();
  const s = live.settings;
  const set = (patch: Partial<LiveSettings>) => liveStore.updateSettings(patch);

  return (
    <Screen>
      <TopBar back title="Live settings" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md }}>
        <Card style={{ gap: space.lg }}>
          <Txt v="caption" c="muted">
            Claude
          </Txt>
          <Choice
            label="Model for live decisions"
            help={`One decision costs ${perDecision(s.model)} with this model (estimate). Haiku is far cheaper; Sonnet and Opus judge news better.`}
            options={(Object.keys(MODELS) as ModelId[]).map((m) => ({ value: m, label: MODELS[m].label }))}
            value={s.model}
            onChange={(v) => set({ model: v })}
          />
          <Choice
            label="Daily budget"
            help="Live decisions stop for the day at this estimated spend. Calls are paced across the session."
            options={['1', '3', '5', '10'].map((v) => ({ value: v, label: `$${v}` }))}
            value={String(s.dailyBudgetUsd)}
            onChange={(v) => set({ dailyBudgetUsd: Number(v) })}
          />
          <Choice
            label="Check-in every"
            help="Claude reviews positions and the market at least this often, even without new events."
            options={['15', '30', '60'].map((v) => ({ value: v, label: `${v} min` }))}
            value={String(s.checkInMinutes)}
            onChange={(v) => set({ checkInMinutes: Number(v) })}
          />
          <Choice
            label="Least time between decisions"
            options={['1', '3', '5', '10'].map((v) => ({ value: v, label: `${v} min` }))}
            value={String(s.minGapMinutes)}
            onChange={(v) => set({ minGapMinutes: Number(v) })}
          />
        </Card>

        <Card style={{ gap: space.lg }}>
          <Txt v="caption" c="muted">
            Intraday limits (enforced by the app)
          </Txt>
          <Choice
            label="Risk per trade"
            help="Most the account loses if an intraday stop-loss is hit."
            options={['0.25', '0.5', '1'].map((v) => ({ value: v, label: `${v}%` }))}
            value={String(s.riskPerTradePct)}
            onChange={(v) => set({ riskPerTradePct: Number(v) })}
          />
          <Choice
            label="Largest intraday position"
            help="Share of account value (margin is 1/5 of this at 5× leverage)."
            options={['10', '20', '30', '50'].map((v) => ({ value: v, label: `${v}%` }))}
            value={String(s.maxNotionalPct)}
            onChange={(v) => set({ maxNotionalPct: Number(v) })}
          />
          <Choice
            label="Open intraday positions"
            options={['1', '2', '3', '5'].map((v) => ({ value: v, label: v }))}
            value={String(s.maxPositions)}
            onChange={(v) => set({ maxPositions: Number(v) })}
          />
          <Choice
            label="Intraday trades a day"
            options={['3', '6', '10', '15'].map((v) => ({ value: v, label: v }))}
            value={String(s.maxTradesPerDay)}
            onChange={(v) => set({ maxTradesPerDay: Number(v) })}
          />
          <Choice
            label="Stop new trades after a day’s loss of"
            options={['1', '2', '3', '5'].map((v) => ({ value: v, label: `${v}%` }))}
            value={String(s.dailyLossLimitPct)}
            onChange={(v) => set({ dailyLossLimitPct: Number(v) })}
          />
          <Choice
            label="Last new entry (IST)"
            options={['13:30', '14:15', '14:45', '15:00'].map((v) => ({ value: v, label: v }))}
            value={s.lastEntry}
            onChange={(v) => set({ lastEntry: v })}
          />
          <Choice
            label="Minimum liquidity"
            help="20-day average traded value."
            options={['10', '25', '50', '100'].map((v) => ({ value: v, label: `₹${v} Cr` }))}
            value={String(s.minLiquidityCr)}
            onChange={(v) => set({ minLiquidityCr: Number(v) })}
          />
          <Toggle label="Allow short selling" help="Intraday shorts only; they’re squared off the same day." value={s.allowShort} onChange={(v) => set({ allowShort: v })} />
        </Card>

        <Card style={{ gap: space.lg }}>
          <Txt v="caption" c="muted">
            News and device
          </Txt>
          <Toggle label="Zerodha Pulse headlines" help="Business news from Indian media, checked every 2 minutes." value={s.newsPulse} onChange={(v) => set({ newsPulse: v })} />
          <Toggle label="NSE corporate filings" help="Results, board outcomes, orders and other announcements, checked every 5 minutes." value={s.newsNse} onChange={(v) => set({ newsNse: v })} />
          <Toggle label="Keep the screen on" help="During market hours while Live mode is on. Android may pause the app if the screen turns off." value={s.keepAwake} onChange={(v) => set({ keepAwake: v })} />
        </Card>

        <Card style={{ gap: space.md }}>
          <Txt v="caption" c="muted">
            History
          </Txt>
          <Txt v="small" c="muted">
            {live.runs.length} live decisions and {live.events.length} events saved on this phone. Swing limits and your instructions to the AI
            are shared with the AI settings.
          </Txt>
          <Button label="Clear history before today" variant="danger" disabled={live.runs.length === 0 && live.events.length === 0} onPress={() => liveStore.clearHistory()} />
        </Card>
      </ScrollView>
    </Screen>
  );
}
