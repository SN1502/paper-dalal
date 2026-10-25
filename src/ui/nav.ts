import { useRouter } from 'expo-router';

import type { OrderType, Product, Side } from '../engine/types';

export interface OrderParams {
  symbol: string;
  side: Side;
  product?: Product;
  qty?: number;
  type?: OrderType;
  /** Present when modifying an existing order. */
  orderId?: string;
}

export function useNav() {
  const router = useRouter();
  return {
    stock(symbol: string) {
      router.push({ pathname: '/stock/[symbol]', params: { symbol } });
    },
    order(p: OrderParams) {
      const params: Record<string, string> = { symbol: p.symbol, side: p.side };
      if (p.product) params.product = p.product;
      if (p.qty) params.qty = String(p.qty);
      if (p.type) params.type = p.type;
      if (p.orderId) params.orderId = p.orderId;
      router.push({ pathname: '/order', params });
    },
    search() {
      router.push('/search');
    },
    tab(name: 'index' | 'orders' | 'portfolio' | 'funds') {
      router.navigate(name === 'index' ? '/' : `/${name}`);
    },
  };
}
