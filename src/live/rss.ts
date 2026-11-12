/** Minimal RSS 2.0 / Atom parsing with no DOM, for React Native. */
import { IST_OFFSET_MS } from '../lib/time';

export interface FeedItem {
  title: string;
  link: string;
  description: string;
  publishedAt: number | null;
  guid: string;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeOnce(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+|#39);/g, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[code] ?? m;
  });
}

/** Decodes XML/HTML entities, including double-escaped ones such as "&amp;amp;". */
export function decodeEntities(s: string): string {
  let out = s;
  for (let i = 0; i < 2; i++) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

export function stripTags(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : null;
}

function text(block: string, name: string): string {
  const raw = tag(block, name);
  if (raw === null) return '';
  // Entities are decoded before tags are stripped, so escaped HTML in descriptions is removed too.
  return stripTags(decodeEntities(cdata(raw)));
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * Parses RFC 822 dates ("Wed, 11 Nov 2026 22:31:34 +0530"), ISO 8601 and NSE's
 * "12-Nov-2026 13:57:40" (IST). Returns epoch ms or null.
 */
export function parseFeedDate(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo === undefined) return null;
    return Date.UTC(+m[3], mo, +m[1], +m[4], +m[5], +(m[6] ?? 0)) - IST_OFFSET_MS;
  }
  m = s.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|GMT|UTC|UT|Z|IST)?/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo === undefined) return null;
    let offsetMin = 0;
    const tz = m[7];
    if (tz && /^[+-]\d{4}$/.test(tz)) {
      const sign = tz[0] === '-' ? -1 : 1;
      offsetMin = sign * (parseInt(tz.slice(1, 3), 10) * 60 + parseInt(tz.slice(3), 10));
    } else if (tz === 'IST') {
      offsetMin = 330;
    }
    return Date.UTC(+m[3], mo, +m[1], +m[4], +m[5], +(m[6] ?? 0)) - offsetMin * 60_000;
  }
  m = s.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/);
  if (m) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export function parseRss(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const re = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[2];
    const title = text(block, 'title');
    let link = text(block, 'link');
    if (!link) {
      const href = block.match(/<link[^>]*href="([^"]+)"/i);
      if (href) link = decodeEntities(href[1]);
    }
    const description = text(block, 'description') || text(block, 'summary') || text(block, 'content');
    const date = text(block, 'pubDate') || text(block, 'published') || text(block, 'updated') || text(block, 'dc:date');
    const guid = text(block, 'guid') || link || title;
    if (!title) continue;
    items.push({ title, link, description, publishedAt: parseFeedDate(date), guid });
  }
  return items;
}
