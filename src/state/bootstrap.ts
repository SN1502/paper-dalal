import { aiStore } from '../ai/store';
import { liveStore } from '../live/store';
import { strategyStore } from '../strategies/store';
import { controller } from './controller';
import { engineStore } from './engineStore';
import { quoteStore } from './quoteStore';

let boot: Promise<void> | null = null;

/**
 * Loads saved state once. In the foreground it also starts the price loop; a background
 * task only needs the data and drives refreshes itself.
 */
export function bootstrap(opts: { background?: boolean } = {}): Promise<void> {
  if (!boot) {
    boot = Promise.all([engineStore.hydrate(), quoteStore.load(), aiStore.load(), strategyStore.load(), liveStore.load()]).then(() => undefined);
  }
  return boot.then(() => {
    if (!opts.background) controller.start();
  });
}
