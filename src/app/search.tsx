import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Keyboard, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { INDICES, POPULAR, instrumentFromSymbol, searchLocal, symbolFromUserText } from '@/data/instruments';
import { yahooSearch } from '@/data/yahoo';
import type { Exchange, Instrument } from '@/engine/types';
import { controller } from '@/state/controller';
import { useEngine } from '@/state/engineStore';
import { Divider, IconButton, Screen, Segmented, Txt } from '@/ui/kit';
import { useNav } from '@/ui/nav';
import { radius, space, typeScale, usePalette } from '@/ui/theme';

type Row = { kind: 'inst'; inst: Instrument } | { kind: 'lookup'; symbol: string } | { kind: 'label'; text: string };

export default function SearchScreen() {
  const p = usePalette();
  const router = useRouter();
  const nav = useNav();
  const state = useEngine();
  const [query, setQuery] = useState('');
  const [exchange, setExchange] = useState<Exchange>('NSE');
  const [remote, setRemote] = useState<Instrument[]>([]);
  const [loading, setLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setRemote([]);
      setLoading(false);
      setRemoteError(null);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const hits = await yahooSearch(q);
        if (id !== seq.current) return;
        setRemote(hits.map((h) => instrumentFromSymbol(h.symbol, h.name)));
        setRemoteError(null);
      } catch {
        if (id !== seq.current) return;
        setRemote([]);
        setRemoteError('Live search is unavailable right now. Showing popular matches.');
      } finally {
        if (id === seq.current) setLoading(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);

  const watched = useMemo(() => new Set(state.watchlist.map((i) => i.symbol)), [state.watchlist]);

  const rows: Row[] = useMemo(() => {
    const q = query.trim();
    if (!q) {
      return [
        { kind: 'label', text: 'Indices' },
        ...INDICES.map((inst) => ({ kind: 'inst' as const, inst })),
        { kind: 'label', text: 'Popular on NSE' },
        ...POPULAR.filter((i) => !watched.has(i.symbol))
          .slice(0, 25)
          .map((inst) => ({ kind: 'inst' as const, inst })),
      ];
    }
    const seen = new Set<string>();
    const out: Row[] = [];
    const push = (inst: Instrument) => {
      if (seen.has(inst.symbol)) return;
      if (!inst.isIndex && inst.exchange !== exchange) return;
      seen.add(inst.symbol);
      out.push({ kind: 'inst', inst });
    };
    searchLocal(q).forEach(push);
    remote.forEach(push);
    const typed = symbolFromUserText(q, exchange);
    if (typed && !seen.has(typed)) out.push({ kind: 'lookup', symbol: typed });
    return out;
  }, [query, remote, exchange, watched]);

  const open = (symbol: string) => {
    Keyboard.dismiss();
    router.back();
    setTimeout(() => nav.stock(symbol), 50);
  };

  return (
    <Screen>
      <View style={styles.head}>
        <View style={[styles.inputBox, { backgroundColor: p.surface, borderColor: p.border }]}>
          <Ionicons name="search" size={18} color={p.faint} />
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder="Company or symbol, e.g. Infosys, TCS"
            placeholderTextColor={p.faint}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="search"
            style={[typeScale.body, styles.input, { color: p.text }]}
            accessibilityLabel="Search stocks"
          />
          {loading ? <ActivityIndicator size="small" color={p.accent} /> : null}
          {query ? <IconButton name="close-circle" size={18} label="Clear search" color={p.faint} onPress={() => setQuery('')} /> : null}
        </View>
        <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="button">
          <Txt v="bodyStrong" c="accent">
            Done
          </Txt>
        </Pressable>
      </View>
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
        <Segmented
          size="sm"
          options={[
            { value: 'NSE', label: 'NSE' },
            { value: 'BSE', label: 'BSE' },
          ]}
          value={exchange}
          onChange={setExchange}
        />
      </View>
      {remoteError ? (
        <Txt v="small" c="warn" style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
          {remoteError}
        </Txt>
      ) : null}
      <FlatList
        data={rows}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(r, i) => (r.kind === 'inst' ? r.inst.symbol : r.kind === 'lookup' ? `lookup-${r.symbol}` : `label-${i}`)}
        renderItem={({ item }) => {
          if (item.kind === 'label') {
            return (
              <Txt v="caption" c="muted" style={{ paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm }}>
                {item.text}
              </Txt>
            );
          }
          if (item.kind === 'lookup') {
            return (
              <Pressable
                onPress={() => open(item.symbol)}
                style={({ pressed }) => [styles.row, { backgroundColor: pressed ? p.surfaceAlt : 'transparent' }]}
              >
                <Ionicons name="open-outline" size={18} color={p.accent} />
                <Txt v="body" c="accent" style={{ flex: 1 }}>
                  Look up {item.symbol.replace(/\.(NS|BO)$/, '')} on {exchange}
                </Txt>
              </Pressable>
            );
          }
          const inst = item.inst;
          const isWatched = watched.has(inst.symbol);
          return (
            <Pressable
              onPress={() => open(inst.symbol)}
              style={({ pressed }) => [styles.row, { backgroundColor: pressed ? p.surfaceAlt : 'transparent' }]}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                  <Txt v="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
                    {inst.tradingSymbol}
                  </Txt>
                  <Txt v="caption" c="faint">
                    {inst.isIndex ? 'INDEX' : inst.exchange}
                  </Txt>
                </View>
                <Txt v="small" c="muted" numberOfLines={1}>
                  {inst.name}
                </Txt>
              </View>
              {!inst.isIndex ? (
                <IconButton
                  name={isWatched ? 'checkmark-circle' : 'add-circle-outline'}
                  color={isWatched ? p.up : p.accent}
                  label={isWatched ? `Remove ${inst.tradingSymbol} from watchlist` : `Add ${inst.tradingSymbol} to watchlist`}
                  onPress={() => (isWatched ? controller.removeFromWatchlist(inst.symbol) : controller.addToWatchlist(inst))}
                />
              ) : null}
            </Pressable>
          );
        }}
        ItemSeparatorComponent={() => <Divider inset={space.lg} />}
        ListEmptyComponent={
          query.trim() && !loading ? (
            <Txt v="body" c="muted" align="center" style={{ padding: space.xl }}>
              No matches on {exchange}. Check the spelling or try the exchange symbol.
            </Txt>
          ) : undefined
        }
        contentContainerStyle={{ paddingBottom: space.xxl }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.md },
  inputBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.md,
    paddingRight: space.xs,
    minHeight: 46,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: { flex: 1, minWidth: 0, paddingVertical: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 56 },
});
