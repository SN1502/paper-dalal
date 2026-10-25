import { controller } from './controller';
import { engineStore } from './engineStore';
import { quoteStore } from './quoteStore';

let boot: Promise<void> | null = null;

/** Loads saved state once and starts the price loop. Safe to call repeatedly. */
export function bootstrap(): Promise<void> {
  if (!boot) {
    boot = (async () => {
      await Promise.all([engineStore.hydrate(), quoteStore.load()]);
      controller.start();
    })();
  }
  return boot;
}
