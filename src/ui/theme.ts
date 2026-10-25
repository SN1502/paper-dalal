import { useColorScheme } from 'react-native';

/**
 * PaperDalal palette: cool slate neutrals with a faint indigo bias, indigo ink as the
 * brand/buy colour, a warm vermilion for sell, and separate gain/loss greens and reds.
 */
const light = {
  bg: '#F3F4F8',
  surface: '#FFFFFF',
  surfaceAlt: '#ECEEF4',
  border: '#DDE1EA',
  text: '#10131C',
  muted: '#5D6578',
  faint: '#949BAD',
  accent: '#3B4CCA',
  accentSoft: '#E6E9FB',
  buy: '#3B4CCA',
  buySoft: '#E6E9FB',
  sell: '#D9472F',
  sellSoft: '#FBE7E3',
  up: '#0F8F5F',
  upSoft: '#E1F4EC',
  down: '#D23A46',
  downSoft: '#FBE6E8',
  warn: '#A86A12',
  warnSoft: '#FBF0DC',
  onAccent: '#FFFFFF',
  flashUp: 'rgba(15,143,95,0.18)',
  flashDown: 'rgba(210,58,70,0.18)',
  scrim: 'rgba(9,11,18,0.45)',
  shadow: 'rgba(16,19,28,0.10)',
};

export type Palette = typeof light;

const dark: Palette = {
  bg: '#0B0D13',
  surface: '#141822',
  surfaceAlt: '#1B2030',
  border: '#262C3C',
  text: '#E9ECF4',
  muted: '#9AA2B5',
  faint: '#666E85',
  accent: '#8391FF',
  accentSoft: '#1F2547',
  buy: '#6F80FF',
  buySoft: '#1F2547',
  sell: '#FF6B52',
  sellSoft: '#3A1E1A',
  up: '#35C48F',
  upSoft: '#11291F',
  down: '#FF6673',
  downSoft: '#33181C',
  warn: '#E9B44C',
  warnSoft: '#33280F',
  onAccent: '#FFFFFF',
  flashUp: 'rgba(53,196,143,0.20)',
  flashDown: 'rgba(255,102,115,0.20)',
  scrim: 'rgba(0,0,0,0.6)',
  shadow: 'rgba(0,0,0,0.4)',
};

export const palettes = { light, dark };

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

export function useIsDark(): boolean {
  return useColorScheme() === 'dark';
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 14, xl: 20, pill: 999 } as const;

export const typeScale = {
  display: { fontSize: 32, lineHeight: 38, fontWeight: '700' as const, letterSpacing: -0.6 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' as const, letterSpacing: -0.3 },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: '600' as const },
  body: { fontSize: 15, lineHeight: 20, fontWeight: '400' as const },
  bodyStrong: { fontSize: 15, lineHeight: 20, fontWeight: '600' as const },
  small: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const },
  smallStrong: { fontSize: 13, lineHeight: 18, fontWeight: '600' as const },
  caption: { fontSize: 11, lineHeight: 14, fontWeight: '600' as const, letterSpacing: 0.8, textTransform: 'uppercase' as const },
};

export type TypeVariant = keyof typeof typeScale;

/** Gain/loss colour for a signed number. */
export function toneOf(p: Palette, value: number | null | undefined): string {
  if (value === null || value === undefined || Math.abs(value) < 0.005) return p.muted;
  return value > 0 ? p.up : p.down;
}
