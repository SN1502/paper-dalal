/** Matches news headlines and exchange filings to stocks in the app's universe. */
import type { Instrument } from '../engine/types';

/** Short names headlines use, beyond the company's own name. */
const EXTRA_ALIASES: Record<string, string[]> = {
  RELIANCE: ['Reliance Industries', 'RIL'],
  TCS: ['TCS'],
  HDFCBANK: ['HDFC Bank'],
  ICICIBANK: ['ICICI Bank'],
  INFY: ['Infosys'],
  BHARTIARTL: ['Airtel', 'Bharti Airtel'],
  SBIN: ['SBI', 'State Bank'],
  ITC: ['ITC'],
  LT: ['L&T', 'Larsen'],
  HINDUNILVR: ['HUL', 'Hindustan Unilever'],
  KOTAKBANK: ['Kotak Mahindra Bank', 'Kotak Bank'],
  AXISBANK: ['Axis Bank'],
  BAJFINANCE: ['Bajaj Finance'],
  BAJAJFINSV: ['Bajaj Finserv'],
  'BAJAJ-AUTO': ['Bajaj Auto'],
  MARUTI: ['Maruti', 'Maruti Suzuki'],
  'M&M': ['M&M', 'Mahindra & Mahindra'],
  SUNPHARMA: ['Sun Pharma'],
  HCLTECH: ['HCLTech', 'HCL Tech', 'HCL Technologies'],
  WIPRO: ['Wipro'],
  TECHM: ['Tech Mahindra'],
  LTIM: ['LTIMindtree'],
  TITAN: ['Titan'],
  ASIANPAINT: ['Asian Paints'],
  ULTRACEMCO: ['UltraTech'],
  GRASIM: ['Grasim'],
  NTPC: ['NTPC'],
  POWERGRID: ['Power Grid', 'PowerGrid'],
  ONGC: ['ONGC'],
  COALINDIA: ['Coal India'],
  IOC: ['IOC', 'Indian Oil'],
  BPCL: ['BPCL'],
  GAIL: ['GAIL'],
  TATASTEEL: ['Tata Steel'],
  JSWSTEEL: ['JSW Steel'],
  HINDALCO: ['Hindalco'],
  VEDL: ['Vedanta'],
  HINDZINC: ['Hindustan Zinc'],
  SAIL: ['SAIL'],
  NMDC: ['NMDC'],
  NESTLEIND: ['Nestle India'],
  BRITANNIA: ['Britannia'],
  TATACONSUM: ['Tata Consumer'],
  DABUR: ['Dabur'],
  MARICO: ['Marico'],
  GODREJCP: ['Godrej Consumer'],
  COLPAL: ['Colgate-Palmolive', 'Colgate'],
  PIDILITIND: ['Pidilite'],
  BERGEPAINT: ['Berger Paints'],
  ADANIENT: ['Adani Enterprises'],
  ADANIPORTS: ['Adani Ports'],
  ADANIGREEN: ['Adani Green'],
  ADANIPOWER: ['Adani Power'],
  AMBUJACEM: ['Ambuja Cements', 'Ambuja Cement'],
  SHREECEM: ['Shree Cement'],
  DRREDDY: ["Dr Reddy's", "Dr. Reddy's", 'Dr Reddys'],
  CIPLA: ['Cipla'],
  DIVISLAB: ["Divi's", 'Divis Labs', "Divi's Laboratories"],
  LUPIN: ['Lupin'],
  AUROPHARMA: ['Aurobindo Pharma'],
  TORNTPHARM: ['Torrent Pharma'],
  ZYDUSLIFE: ['Zydus'],
  APOLLOHOSP: ['Apollo Hospitals'],
  MAXHEALTH: ['Max Healthcare'],
  EICHERMOT: ['Eicher Motors', 'Royal Enfield'],
  HEROMOTOCO: ['Hero MotoCorp'],
  TVSMOTOR: ['TVS Motor'],
  HYUNDAI: ['Hyundai Motor India'],
  MOTHERSON: ['Motherson'],
  BOSCHLTD: ['Bosch'],
  MRF: ['MRF'],
  INDUSINDBK: ['IndusInd Bank', 'IndusInd'],
  BANKBARODA: ['Bank of Baroda'],
  PNB: ['PNB', 'Punjab National Bank'],
  CANBK: ['Canara Bank'],
  FEDERALBNK: ['Federal Bank'],
  IDFCFIRSTB: ['IDFC First Bank', 'IDFC First'],
  AUBANK: ['AU Small Finance Bank', 'AU Bank'],
  BANDHANBNK: ['Bandhan Bank'],
  YESBANK: ['Yes Bank'],
  SHRIRAMFIN: ['Shriram Finance'],
  CHOLAFIN: ['Cholamandalam'],
  MUTHOOTFIN: ['Muthoot Finance'],
  BAJAJHLDNG: ['Bajaj Holdings'],
  JIOFIN: ['Jio Financial'],
  SBILIFE: ['SBI Life'],
  HDFCLIFE: ['HDFC Life'],
  ICICIGI: ['ICICI Lombard'],
  ICICIPRULI: ['ICICI Prudential Life', 'ICICI Pru Life'],
  LICI: ['LIC', 'Life Insurance Corporation'],
  RECLTD: ['REC Ltd', 'REC Limited'],
  PFC: ['PFC', 'Power Finance Corporation'],
  IRFC: ['IRFC'],
  IRCTC: ['IRCTC'],
  RVNL: ['RVNL', 'Rail Vikas Nigam'],
  HAL: ['HAL', 'Hindustan Aeronautics'],
  BEL: ['BEL', 'Bharat Electronics'],
  BHEL: ['BHEL'],
  MAZDOCK: ['Mazagon Dock'],
  SIEMENS: ['Siemens'],
  ABB: ['ABB India'],
  HAVELLS: ['Havells'],
  POLYCAB: ['Polycab'],
  DIXON: ['Dixon Technologies', 'Dixon Tech'],
  VOLTAS: ['Voltas'],
  ASTRAL: ['Astral'],
  TATAPOWER: ['Tata Power'],
  SUZLON: ['Suzlon'],
  DLF: ['DLF'],
  TRENT: ['Trent'],
  DMART: ['DMart', 'Avenue Supermarts'],
  ETERNAL: ['Eternal', 'Zomato', 'Blinkit'],
  SWIGGY: ['Swiggy'],
  NYKAA: ['Nykaa'],
  PAYTM: ['Paytm', 'One97'],
  POLICYBZR: ['Policybazaar', 'PB Fintech'],
  NAUKRI: ['Info Edge', 'Naukri'],
  DELHIVERY: ['Delhivery'],
  INDIGO: ['IndiGo', 'InterGlobe'],
  IDEA: ['Vodafone Idea', 'Vi'],
  PERSISTENT: ['Persistent Systems'],
  COFORGE: ['Coforge'],
  MPHASIS: ['Mphasis'],
  OFSS: ['Oracle Financial Services'],
  KPITTECH: ['KPIT'],
  TATAELXSI: ['Tata Elxsi'],
  BSE: ['BSE Ltd'],
  CDSL: ['CDSL'],
};

/** Parenthetical words too generic to identify a company. */
const GENERIC = new Set(['India', 'Zomato']);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function aliasesFor(inst: Instrument): string[] {
  const out = new Set<string>(EXTRA_ALIASES[inst.tradingSymbol] ?? []);
  const base = inst.name.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  if (base.length >= 3) out.add(base);
  const paren = /\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = paren.exec(inst.name)) !== null) if (!GENERIC.has(m[1])) out.add(m[1]);
  return [...out].filter((a) => a.length >= 2);
}

export interface Matcher {
  symbol: string;
  patterns: RegExp[];
}

/**
 * Case-sensitive whole-word patterns: company names are capitalised in headlines, which keeps
 * words like "titan" or "eternal" in ordinary text from matching.
 */
export function buildMatchers(instruments: Instrument[]): Matcher[] {
  return instruments
    .filter((i) => !i.isIndex)
    .map((i) => ({
      symbol: i.symbol,
      patterns: aliasesFor(i).map((a) => new RegExp(`(^|[^A-Za-z0-9])${escapeRe(a)}(?![A-Za-z0-9])`)),
    }));
}

export function matchSymbols(text: string, matchers: Matcher[]): string[] {
  const out: string[] = [];
  for (const m of matchers) if (m.patterns.some((p) => p.test(text))) out.push(m.symbol);
  return out;
}

/** "Info Edge (India) Limited" -> "info edge"; used to match NSE filings by company name. */
export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(the|limited|ltd|ltd\.)\b/g, ' ')
    .replace(/[^a-z0-9&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function companyIndex(instruments: Instrument[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const i of instruments) if (!i.isIndex) map.set(normalizeCompany(i.name), i.symbol);
  return map;
}

const MACRO = /\b(Sensex|Nifty|RBI|repo rate|inflation|CPI|WPI|GDP|US Fed|Fed rate|FOMC|Federal Reserve|crude|Brent|rupee|FIIs?|FPIs?|DIIs?|Union Budget|GST council|SEBI|tariffs?|monetary policy|bond yields?)\b/i;

export function isMacroHeadline(text: string): boolean {
  return MACRO.test(text);
}

/** NSE filing subjects that rarely move a stock. */
const ROUTINE =
  /trading window|newspaper publication|certificate under|compliance certificate|loss of share|duplicate share|investor presentation|analysts?\/institutional investor meet|con\. call|esop|esos|sebi \(depositories|reg\.? ?74|change in registrar|book closure|record date|shareholders? meeting|postal ballot|annual report|secretarial|closure of trading/i;

export function isRoutineFiling(text: string): boolean {
  return ROUTINE.test(text);
}
