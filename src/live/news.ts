/**
 * Market news for Live mode: Zerodha Pulse (headlines from Indian business media) and the
 * NSE corporate-announcements feed, matched to stocks in the app's universe.
 */
import type { Instrument } from '../engine/types';
import { buildMatchers, companyIndex, isMacroHeadline, isRoutineFiling, matchSymbols, normalizeCompany, type Matcher } from './match';
import { parseRss, type FeedItem } from './rss';

export type NewsSource = 'pulse' | 'nse';

export interface NewsItem {
  id: string;
  source: NewsSource;
  title: string;
  summary: string;
  link: string;
  publishedAt: number;
  /** Universe symbols the item is about (".NS" form). */
  symbols: string[];
  macro: boolean;
  /** Names one to three universe stocks and isn't a routine filing. */
  important: boolean;
}

export const FEEDS: Record<NewsSource, { url: string; everyMs: number; label: string }> = {
  pulse: { url: 'https://pulse.zerodha.com/feed.php', everyMs: 2 * 60_000, label: 'Zerodha Pulse' },
  nse: {
    url: 'https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml',
    everyMs: 5 * 60_000,
    label: 'NSE announcements',
  },
};

const MAX_ITEMS = 300;
/** On the first poll of a session, only items this recent count as new. */
const FIRST_RUN_WINDOW_MS = 30 * 60_000;
/** Items older than this never trigger the AI, even if the feed only now shows them. */
const MAX_EVENT_AGE_MS = 3 * 60 * 60_000;

/** FNV-1a, enough to give feed items short stable ids. */
export function hashId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}${s.length.toString(36)}`;
}

export interface MatchContext {
  matchers: Matcher[];
  companies: Map<string, string>;
}

export function matchContext(instruments: Instrument[]): MatchContext {
  return { matchers: buildMatchers(instruments), companies: companyIndex(instruments) };
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

export function toNewsItems(source: NewsSource, items: FeedItem[], ctx: MatchContext, now: number): NewsItem[] {
  return items.map((it) => {
    const publishedAt = it.publishedAt !== null && it.publishedAt <= now + 5 * 60_000 ? it.publishedAt : now;
    if (source === 'nse') {
      const company = it.title.trim();
      const subject = it.description.trim();
      const sym = ctx.companies.get(normalizeCompany(company)) ?? matchSymbols(company, ctx.matchers)[0] ?? null;
      const symbols = sym ? [sym] : [];
      return {
        id: hashId(`nse|${it.link || it.guid}|${company}|${subject.slice(0, 120)}`),
        source,
        title: clip(subject ? `${company}: ${subject}` : company, 220),
        summary: clip(subject, 500),
        link: it.link,
        publishedAt,
        symbols,
        macro: false,
        important: symbols.length > 0 && !isRoutineFiling(subject),
      };
    }
    const symbols = matchSymbols(it.title, ctx.matchers);
    return {
      id: hashId(`pulse|${it.guid || it.link || it.title}`),
      source,
      title: clip(it.title, 220),
      summary: clip(it.description, 500),
      link: it.link,
      publishedAt,
      symbols,
      macro: isMacroHeadline(it.title),
      important: symbols.length > 0 && symbols.length <= 3,
    };
  });
}

/**
 * Adds unseen items to the list (newest first) and returns the ones recent enough to be
 * treated as new events.
 */
export function mergeNews(
  existing: NewsItem[],
  incoming: NewsItem[],
  seen: Set<string>,
  now: number,
  firstRun: boolean,
): { list: NewsItem[]; fresh: NewsItem[]; added: NewsItem[] } {
  const fresh: NewsItem[] = [];
  const added: NewsItem[] = [];
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    added.push(item);
    const age = now - item.publishedAt;
    if (age <= MAX_EVENT_AGE_MS && (!firstRun || age <= FIRST_RUN_WINDOW_MS)) fresh.push(item);
  }
  if (added.length === 0) return { list: existing, fresh, added };
  const list = [...added, ...existing].sort((a, b) => b.publishedAt - a.publishedAt).slice(0, MAX_ITEMS);
  fresh.sort((a, b) => b.publishedAt - a.publishedAt);
  return { list, fresh, added };
}

export interface FeedStatus {
  lastOkAt: number | null;
  lastError: string | null;
  nextAt: number;
  failures: number;
  etag: string | null;
  lastModified: string | null;
}

const HEADERS: Record<string, string> = {
  Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
  'Accept-Language': 'en-IN,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
};

export function emptyFeedStatus(): FeedStatus {
  return { lastOkAt: null, lastError: null, nextAt: 0, failures: 0, etag: null, lastModified: null };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Polls each enabled feed when it's due, with conditional requests and back-off on errors. */
export class NewsPoller {
  status: Record<NewsSource, FeedStatus> = { pulse: emptyFeedStatus(), nse: emptyFeedStatus() };
  private busy = false;

  constructor(
    private fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private timeoutMs = 15_000,
  ) {}

  private async get(source: NewsSource, now: number): Promise<FeedItem[] | null> {
    const st = this.status[source];
    const headers: Record<string, string> = { ...HEADERS };
    if (source === 'nse') headers.Referer = 'https://www.nseindia.com/';
    if (st.etag) headers['If-None-Match'] = st.etag;
    if (st.lastModified) headers['If-Modified-Since'] = st.lastModified;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(FEEDS[source].url, { headers, signal: abort.signal });
      if (res.status === 304) {
        this.ok(source, now);
        return [];
      }
      if (!res.ok) throw new Error(`${FEEDS[source].label} returned ${res.status}`);
      const text = await res.text();
      const items = parseRss(text);
      if (items.length === 0 && !/<(rss|feed|channel)[\s>]/i.test(text)) throw new Error(`${FEEDS[source].label} sent something other than a feed`);
      st.etag = res.headers.get('etag');
      st.lastModified = res.headers.get('last-modified');
      this.ok(source, now);
      return items;
    } catch (e) {
      st.failures += 1;
      const aborted = e instanceof Error && e.name === 'AbortError';
      st.lastError = aborted ? `${FEEDS[source].label} timed out` : e instanceof Error ? e.message : 'Feed unavailable';
      // 2, 4, 8 … minutes, at most 15.
      st.nextAt = now + Math.min(15 * 60_000, FEEDS[source].everyMs * 2 ** Math.min(3, st.failures - 1));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private ok(source: NewsSource, now: number) {
    const st = this.status[source];
    st.lastOkAt = now;
    st.lastError = null;
    st.failures = 0;
    st.nextAt = now + FEEDS[source].everyMs;
  }

  /** Fetches the feeds that are due. Returns items per source that answered with content. */
  async poll(enabled: Record<NewsSource, boolean>, now: number): Promise<{ source: NewsSource; items: FeedItem[] }[]> {
    if (this.busy) return [];
    this.busy = true;
    try {
      const due = (Object.keys(FEEDS) as NewsSource[]).filter((s) => enabled[s] && now >= this.status[s].nextAt);
      const out = await Promise.all(due.map(async (source) => ({ source, items: await this.get(source, now) })));
      return out.filter((x): x is { source: NewsSource; items: FeedItem[] } => x.items !== null && x.items.length > 0);
    } finally {
      this.busy = false;
    }
  }
}
