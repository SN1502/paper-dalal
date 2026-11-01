import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';

import { syncBackgroundTask } from '@/ai/background';
import { MODELS, verifyKey, type ModelId } from '@/ai/claude';
import { aiStore, useAi } from '@/ai/store';
import type { AiSettings } from '@/ai/types';
import { Button, Card, Divider, Screen, Segmented, TopBar, Txt } from '@/ui/kit';
import { ConfirmSheet } from '@/ui/Sheet';
import { radius, space, typeScale, usePalette } from '@/ui/theme';

type Opt<T extends string> = { value: T; label: string };

function Choice<T extends string>({ label, help, options, value, onChange }: { label: string; help?: string; options: Opt<T>[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={{ gap: space.sm }}>
      <View>
        <Txt v="bodyStrong">{label}</Txt>
        {help ? (
          <Txt v="small" c="muted">
            {help}
          </Txt>
        ) : null}
      </View>
      <Segmented options={options} value={value} onChange={onChange} size="sm" />
    </View>
  );
}

function Toggle({ label, help, value, onChange }: { label: string; help: string; value: boolean; onChange: (v: boolean) => void }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt v="bodyStrong">{label}</Txt>
        <Txt v="small" c="muted">
          {help}
        </Txt>
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: p.accent, false: p.border }} thumbColor={p.surface} accessibilityLabel={label} />
    </View>
  );
}

/** Rough cost of one session for the cost hint (tokens observed for a typical run). */
function estimate(model: ModelId, searches: number): string {
  const m = MODELS[model];
  const usd = (60_000 * m.input + 150_000 * m.cacheRead + 30_000 * m.cacheWrite + 12_000 * m.output) / 1e6 + searches * 0.01;
  return `about $${usd.toFixed(2)}`;
}

export default function AiSettingsScreen() {
  const p = usePalette();
  const ai = useAi();
  const s = ai.settings;
  const [keyText, setKeyText] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [guidance, setGuidance] = useState(s.guidance);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const set = (patch: Partial<AiSettings>) => {
    aiStore.updateSettings(patch);
    if (patch.enabled !== undefined) void syncBackgroundTask(patch.enabled && ai.hasKey);
  };

  const saveKey = async () => {
    const key = keyText.trim();
    if (!key.startsWith('sk-ant-')) {
      setKeyMsg({ ok: false, text: 'That doesn’t look like an Anthropic API key. Keys start with “sk-ant-”.' });
      return;
    }
    setVerifying(true);
    setKeyMsg(null);
    try {
      await verifyKey(key);
      await aiStore.setApiKey(key);
      setKeyText('');
      setReplacing(false);
      setKeyMsg({ ok: true, text: 'Key verified and saved securely on this phone.' });
      void syncBackgroundTask(s.enabled);
    } catch (e) {
      setKeyMsg({ ok: false, text: e instanceof Error ? e.message : 'Couldn’t verify the key.' });
    } finally {
      setVerifying(false);
    }
  };

  const showKeyInput = !ai.hasKey || replacing;

  return (
    <Screen>
      <TopBar back title="AI settings" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md }} keyboardShouldPersistTaps="handled">
          <Card style={{ gap: space.md }}>
            <Txt v="caption" c="muted">
              Claude API key
            </Txt>
            {showKeyInput ? (
              <>
                <Txt v="small" c="muted">
                  Create a key in the Claude Console at platform.claude.com, under Settings → API keys. Usage is billed to your
                  Anthropic account. Web search must be allowed for your organization in the Console for news research.
                </Txt>
                <TextInput
                  value={keyText}
                  onChangeText={setKeyText}
                  placeholder="sk-ant-…"
                  placeholderTextColor={p.faint}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[typeScale.body, styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.surface }]}
                  accessibilityLabel="Claude API key"
                />
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  {replacing ? <Button label="Cancel" variant="secondary" style={{ flex: 1 }} onPress={() => setReplacing(false)} /> : null}
                  <Button label="Verify and save" style={{ flex: 1 }} loading={verifying} disabled={!keyText.trim()} onPress={saveKey} />
                </View>
              </>
            ) : (
              <>
                <Txt v="body" num>
                  Saved key ending in ••••{ai.keyHint}
                </Txt>
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  <Button label="Replace" variant="secondary" style={{ flex: 1 }} onPress={() => setReplacing(true)} />
                  <Button label="Remove" variant="danger" style={{ flex: 1 }} onPress={() => setConfirmRemove(true)} />
                </View>
              </>
            )}
            {keyMsg ? (
              <Txt v="small" c={keyMsg.ok ? 'up' : 'down'}>
                {keyMsg.text}
              </Txt>
            ) : null}
          </Card>

          <Card style={{ gap: space.lg }}>
            <Txt v="caption" c="muted">
              Sessions
            </Txt>
            <Toggle
              label="Trade automatically"
              help="Runs on schedule on trading days while the app is open, or in the background when Android allows it."
              value={s.enabled}
              onChange={(v) => set({ enabled: v })}
            />
            <Choice
              label="Schedule (IST)"
              options={[
                { value: 'morning', label: '9:30 AM' },
                { value: 'twice', label: '9:30 AM + 2:45 PM' },
              ]}
              value={s.schedule}
              onChange={(v) => set({ schedule: v })}
            />
            <Choice
              label="Model"
              help={`One session costs ${estimate(s.model, s.maxSearches)} with this model (estimate).`}
              options={(Object.keys(MODELS) as ModelId[]).map((m) => ({ value: m, label: MODELS[m].label }))}
              value={s.model}
              onChange={(v) => set({ model: v })}
            />
            <Choice
              label="Web searches per session"
              options={['4', '8', '12'].map((v) => ({ value: v, label: v }))}
              value={String(s.maxSearches)}
              onChange={(v) => set({ maxSearches: Number(v) })}
            />
          </Card>

          <Card style={{ gap: space.lg }}>
            <Txt v="caption" c="muted">
              Strategy
            </Txt>
            <Toggle
              label="Market filter (dual momentum)"
              help="151 Trading Strategies §4.1.2: when the Nifty 50 is below its 100- and 200-day averages, block new stock buys and allow only gold or silver ETFs."
              value={s.regimeFilter}
              onChange={(v) => set({ regimeFilter: v })}
            />
          </Card>

          <Card style={{ gap: space.lg }}>
            <Txt v="caption" c="muted">
              Risk limits (enforced by the app)
            </Txt>
            <Choice
              label="Largest position"
              help="Share of account value in any one stock."
              options={['5', '10', '15', '20'].map((v) => ({ value: v, label: `${v}%` }))}
              value={String(s.maxPositionPct)}
              onChange={(v) => set({ maxPositionPct: Number(v) })}
            />
            <Choice
              label="Risk per trade"
              help="Most the account loses if a stop-loss is hit."
              options={['0.5', '1', '1.5', '2'].map((v) => ({ value: v, label: `${v}%` }))}
              value={String(s.riskPerTradePct)}
              onChange={(v) => set({ riskPerTradePct: Number(v) })}
            />
            <Choice
              label="AI positions at once"
              options={['4', '6', '8', '10'].map((v) => ({ value: v, label: v }))}
              value={String(s.maxPositions)}
              onChange={(v) => set({ maxPositions: Number(v) })}
            />
            <Choice
              label="New buys per session"
              options={['1', '2', '3'].map((v) => ({ value: v, label: v }))}
              value={String(s.maxNewPerRun)}
              onChange={(v) => set({ maxNewPerRun: Number(v) })}
            />
            <Choice
              label="Cash kept aside"
              options={['10', '20', '30', '40'].map((v) => ({ value: v, label: `${v}%` }))}
              value={String(s.cashReservePct)}
              onChange={(v) => set({ cashReservePct: Number(v) })}
            />
            <Choice
              label="Pause new buys after a drawdown of"
              options={['10', '15', '20', '25'].map((v) => ({ value: v, label: `${v}%` }))}
              value={String(s.maxDrawdownPct)}
              onChange={(v) => set({ maxDrawdownPct: Number(v) })}
            />
            <Choice
              label="Minimum liquidity"
              help="Average daily traded value."
              options={['5', '10', '25', '50'].map((v) => ({ value: v, label: `₹${v} Cr` }))}
              value={String(s.minLiquidityCr)}
              onChange={(v) => set({ minLiquidityCr: Number(v) })}
            />
          </Card>

          <Card style={{ gap: space.lg }}>
            <Txt v="caption" c="muted">
              API budget
            </Txt>
            <Choice
              label="Monthly budget"
              help="Automatic sessions stop for the month at this estimated spend."
              options={['5', '10', '20', '50'].map((v) => ({ value: v, label: `$${v}` }))}
              value={String(s.monthlyBudgetUsd)}
              onChange={(v) => set({ monthlyBudgetUsd: Number(v) })}
            />
            <Choice
              label="Cap per session"
              options={['0.5', '1', '1.5', '3'].map((v) => ({ value: v, label: `$${v}` }))}
              value={String(s.perRunCapUsd)}
              onChange={(v) => set({ perRunCapUsd: Number(v) })}
            />
          </Card>

          <Card style={{ gap: space.md }}>
            <Txt v="caption" c="muted">
              Your instructions to the AI
            </Txt>
            <TextInput
              value={guidance}
              onChangeText={setGuidance}
              onBlur={() => set({ guidance: guidance.slice(0, 1000) })}
              placeholder="e.g. Avoid PSU banks. Prefer large caps. No more than two IT stocks."
              placeholderTextColor={p.faint}
              multiline
              maxLength={1000}
              style={[typeScale.body, styles.input, styles.multiline, { color: p.text, borderColor: p.border, backgroundColor: p.surface }]}
              accessibilityLabel="Instructions to the AI"
            />
            <Txt v="small" c="faint">
              Saved when you leave the box. The app’s risk limits still apply.
            </Txt>
          </Card>

          <Card style={{ gap: space.md }}>
            <Txt v="caption" c="muted">
              Journal
            </Txt>
            <Txt v="small" c="muted">
              {ai.journal.length} sessions saved on this phone.
            </Txt>
            <Divider />
            <Button label="Clear the AI journal" variant="danger" onPress={() => setConfirmClear(true)} disabled={ai.journal.length === 0} />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
      <ConfirmSheet
        visible={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="Remove the API key?"
        body="The AI stops trading until you add a key again. Your positions and journal stay."
        confirmLabel="Remove key"
        destructive
        onConfirm={async () => {
          await aiStore.setApiKey(null);
          void syncBackgroundTask(false);
        }}
      />
      <ConfirmSheet
        visible={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Clear the journal?"
        body="Deletes the record of past AI sessions on this phone. Trades and positions aren’t affected."
        confirmLabel="Clear"
        destructive
        onConfirm={() => aiStore.clearJournal()}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 12 },
  multiline: { minHeight: 96, textAlignVertical: 'top' },
});
