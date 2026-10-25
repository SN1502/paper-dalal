import type { Exchange, Instrument } from '../engine/types';

export const INDICES: Instrument[] = [
  { symbol: '^NSEI', tradingSymbol: 'NIFTY 50', exchange: 'NSE', name: 'Nifty 50 Index', isIndex: true },
  { symbol: '^BSESN', tradingSymbol: 'SENSEX', exchange: 'BSE', name: 'BSE Sensex', isIndex: true },
  { symbol: '^NSEBANK', tradingSymbol: 'NIFTY BANK', exchange: 'NSE', name: 'Nifty Bank Index', isIndex: true },
];

/** Benchmark used to tell a trading day from a holiday. */
export const BENCHMARK = '^NSEI';

/**
 * Well-known NSE stocks and ETFs for instant offline search.
 * Anything else is found through live search.
 */
const POPULAR_NSE: Array<[string, string]> = [
  ['RELIANCE', 'Reliance Industries'],
  ['TCS', 'Tata Consultancy Services'],
  ['HDFCBANK', 'HDFC Bank'],
  ['ICICIBANK', 'ICICI Bank'],
  ['INFY', 'Infosys'],
  ['BHARTIARTL', 'Bharti Airtel'],
  ['SBIN', 'State Bank of India'],
  ['ITC', 'ITC'],
  ['LT', 'Larsen & Toubro'],
  ['HINDUNILVR', 'Hindustan Unilever'],
  ['KOTAKBANK', 'Kotak Mahindra Bank'],
  ['AXISBANK', 'Axis Bank'],
  ['BAJFINANCE', 'Bajaj Finance'],
  ['BAJAJFINSV', 'Bajaj Finserv'],
  ['BAJAJ-AUTO', 'Bajaj Auto'],
  ['MARUTI', 'Maruti Suzuki India'],
  ['M&M', 'Mahindra & Mahindra'],
  ['SUNPHARMA', 'Sun Pharmaceutical'],
  ['HCLTECH', 'HCL Technologies'],
  ['WIPRO', 'Wipro'],
  ['TECHM', 'Tech Mahindra'],
  ['LTIM', 'LTIMindtree'],
  ['TITAN', 'Titan Company'],
  ['ASIANPAINT', 'Asian Paints'],
  ['ULTRACEMCO', 'UltraTech Cement'],
  ['GRASIM', 'Grasim Industries'],
  ['NTPC', 'NTPC'],
  ['POWERGRID', 'Power Grid Corporation'],
  ['ONGC', 'Oil & Natural Gas Corporation'],
  ['COALINDIA', 'Coal India'],
  ['IOC', 'Indian Oil Corporation'],
  ['BPCL', 'Bharat Petroleum'],
  ['GAIL', 'GAIL (India)'],
  ['TATASTEEL', 'Tata Steel'],
  ['JSWSTEEL', 'JSW Steel'],
  ['HINDALCO', 'Hindalco Industries'],
  ['VEDL', 'Vedanta'],
  ['HINDZINC', 'Hindustan Zinc'],
  ['SAIL', 'Steel Authority of India'],
  ['NMDC', 'NMDC'],
  ['NESTLEIND', 'Nestle India'],
  ['BRITANNIA', 'Britannia Industries'],
  ['TATACONSUM', 'Tata Consumer Products'],
  ['DABUR', 'Dabur India'],
  ['MARICO', 'Marico'],
  ['GODREJCP', 'Godrej Consumer Products'],
  ['COLPAL', 'Colgate-Palmolive (India)'],
  ['PIDILITIND', 'Pidilite Industries'],
  ['BERGEPAINT', 'Berger Paints India'],
  ['ADANIENT', 'Adani Enterprises'],
  ['ADANIPORTS', 'Adani Ports and SEZ'],
  ['ADANIGREEN', 'Adani Green Energy'],
  ['ADANIPOWER', 'Adani Power'],
  ['AMBUJACEM', 'Ambuja Cements'],
  ['SHREECEM', 'Shree Cement'],
  ['DRREDDY', "Dr. Reddy's Laboratories"],
  ['CIPLA', 'Cipla'],
  ['DIVISLAB', "Divi's Laboratories"],
  ['LUPIN', 'Lupin'],
  ['AUROPHARMA', 'Aurobindo Pharma'],
  ['TORNTPHARM', 'Torrent Pharmaceuticals'],
  ['ZYDUSLIFE', 'Zydus Lifesciences'],
  ['APOLLOHOSP', 'Apollo Hospitals'],
  ['MAXHEALTH', 'Max Healthcare'],
  ['EICHERMOT', 'Eicher Motors'],
  ['HEROMOTOCO', 'Hero MotoCorp'],
  ['TVSMOTOR', 'TVS Motor Company'],
  ['HYUNDAI', 'Hyundai Motor India'],
  ['MOTHERSON', 'Samvardhana Motherson'],
  ['BOSCHLTD', 'Bosch'],
  ['MRF', 'MRF'],
  ['INDUSINDBK', 'IndusInd Bank'],
  ['BANKBARODA', 'Bank of Baroda'],
  ['PNB', 'Punjab National Bank'],
  ['CANBK', 'Canara Bank'],
  ['FEDERALBNK', 'Federal Bank'],
  ['IDFCFIRSTB', 'IDFC First Bank'],
  ['AUBANK', 'AU Small Finance Bank'],
  ['BANDHANBNK', 'Bandhan Bank'],
  ['YESBANK', 'Yes Bank'],
  ['SHRIRAMFIN', 'Shriram Finance'],
  ['CHOLAFIN', 'Cholamandalam Investment'],
  ['MUTHOOTFIN', 'Muthoot Finance'],
  ['BAJAJHLDNG', 'Bajaj Holdings & Investment'],
  ['JIOFIN', 'Jio Financial Services'],
  ['SBILIFE', 'SBI Life Insurance'],
  ['HDFCLIFE', 'HDFC Life Insurance'],
  ['ICICIGI', 'ICICI Lombard General Insurance'],
  ['ICICIPRULI', 'ICICI Prudential Life Insurance'],
  ['LICI', 'Life Insurance Corporation of India'],
  ['RECLTD', 'REC'],
  ['PFC', 'Power Finance Corporation'],
  ['IRFC', 'Indian Railway Finance Corporation'],
  ['IRCTC', 'Indian Railway Catering and Tourism'],
  ['RVNL', 'Rail Vikas Nigam'],
  ['HAL', 'Hindustan Aeronautics'],
  ['BEL', 'Bharat Electronics'],
  ['BHEL', 'Bharat Heavy Electricals'],
  ['MAZDOCK', 'Mazagon Dock Shipbuilders'],
  ['SIEMENS', 'Siemens'],
  ['ABB', 'ABB India'],
  ['HAVELLS', 'Havells India'],
  ['POLYCAB', 'Polycab India'],
  ['DIXON', 'Dixon Technologies'],
  ['VOLTAS', 'Voltas'],
  ['ASTRAL', 'Astral'],
  ['TATAPOWER', 'Tata Power'],
  ['SUZLON', 'Suzlon Energy'],
  ['DLF', 'DLF'],
  ['TRENT', 'Trent'],
  ['DMART', 'Avenue Supermarts'],
  ['ETERNAL', 'Eternal (Zomato)'],
  ['SWIGGY', 'Swiggy'],
  ['NYKAA', 'FSN E-Commerce (Nykaa)'],
  ['PAYTM', 'One 97 Communications (Paytm)'],
  ['POLICYBZR', 'PB Fintech (Policybazaar)'],
  ['NAUKRI', 'Info Edge (India)'],
  ['DELHIVERY', 'Delhivery'],
  ['INDIGO', 'InterGlobe Aviation (IndiGo)'],
  ['IDEA', 'Vodafone Idea'],
  ['PERSISTENT', 'Persistent Systems'],
  ['COFORGE', 'Coforge'],
  ['MPHASIS', 'Mphasis'],
  ['OFSS', 'Oracle Financial Services Software'],
  ['KPITTECH', 'KPIT Technologies'],
  ['TATAELXSI', 'Tata Elxsi'],
  ['BSE', 'BSE Ltd'],
  ['CDSL', 'Central Depository Services'],
  ['NIFTYBEES', 'Nippon India ETF Nifty 50 BeES'],
  ['BANKBEES', 'Nippon India ETF Nifty Bank BeES'],
  ['JUNIORBEES', 'Nippon India ETF Nifty Next 50 BeES'],
  ['ITBEES', 'Nippon India ETF Nifty IT'],
  ['GOLDBEES', 'Nippon India ETF Gold BeES'],
  ['SILVERBEES', 'Nippon India Silver ETF'],
];

export const POPULAR: Instrument[] = POPULAR_NSE.map(([ts, name]) => ({
  symbol: `${ts}.NS`,
  tradingSymbol: ts,
  exchange: 'NSE' as Exchange,
  name,
}));

const POPULAR_BY_SYMBOL = new Map(POPULAR.map((i) => [i.symbol, i]));

export const DEFAULT_WATCHLIST: Instrument[] = [
  'RELIANCE',
  'HDFCBANK',
  'ICICIBANK',
  'INFY',
  'TCS',
  'SBIN',
  'BHARTIARTL',
  'ITC',
  'LT',
  'TATASTEEL',
  'BAJFINANCE',
  'NIFTYBEES',
].map((ts) => POPULAR_BY_SYMBOL.get(`${ts}.NS`) as Instrument);

/** Builds an Instrument from a Yahoo symbol such as "INFY.NS", "500325.BO" or "^NSEI". */
export function instrumentFromSymbol(symbol: string, name?: string | null): Instrument {
  const index = INDICES.find((i) => i.symbol === symbol);
  if (index) return index;
  const known = POPULAR_BY_SYMBOL.get(symbol);
  if (known) return known;
  if (symbol.startsWith('^')) {
    return { symbol, tradingSymbol: symbol.slice(1), exchange: 'NSE', name: name || symbol.slice(1), isIndex: true };
  }
  const isBse = symbol.endsWith('.BO');
  const tradingSymbol = symbol.replace(/\.(NS|BO)$/, '');
  return {
    symbol,
    tradingSymbol,
    exchange: isBse ? 'BSE' : 'NSE',
    name: name || tradingSymbol,
  };
}

/** Turns what a user typed ("infy", "INFY.BO") into a candidate Yahoo symbol. */
export function symbolFromUserText(text: string, exchange: Exchange = 'NSE'): string | null {
  const t = text.trim().toUpperCase();
  if (!/^[A-Z0-9&\-.^]{1,20}$/.test(t)) return null;
  if (t.endsWith('.NS') || t.endsWith('.BO') || t.startsWith('^')) return t;
  return `${t}${exchange === 'BSE' ? '.BO' : '.NS'}`;
}

export function searchLocal(query: string, limit = 20): Instrument[] {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const scored: { inst: Instrument; score: number }[] = [];
  for (const inst of [...INDICES, ...POPULAR]) {
    const ts = inst.tradingSymbol.toUpperCase();
    const name = inst.name.toUpperCase();
    let score = -1;
    if (ts === q) score = 100;
    else if (ts.startsWith(q)) score = 80 - ts.length;
    else if (name.startsWith(q)) score = 60;
    else if (name.split(/[\s(]+/).some((w) => w.startsWith(q))) score = 40;
    else if (ts.includes(q) || name.includes(q)) score = 20;
    if (score >= 0) scored.push({ inst, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.inst.tradingSymbol.localeCompare(b.inst.tradingSymbol))
    .slice(0, limit)
    .map((s) => s.inst);
}

const GOOGLE_INDEX: Record<string, string> = {
  '^NSEI': 'NIFTY_50:INDEXNSE',
  '^BSESN': 'SENSEX:INDEXBOM',
  '^NSEBANK': 'NIFTY_BANK:INDEXNSE',
};

/** Google Finance page id for the fallback source; null where it has no simple mapping. */
export function googleTicker(inst: Instrument): string | null {
  if (inst.isIndex) return GOOGLE_INDEX[inst.symbol] ?? null;
  if (inst.exchange !== 'NSE') return null;
  return `${encodeURIComponent(inst.tradingSymbol)}:NSE`;
}
