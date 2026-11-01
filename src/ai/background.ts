/**
 * Lets the scheduled AI session run while the app is in the background.
 * The OS decides exact timing (Android WorkManager, at least every 15 minutes when
 * conditions allow); a swiped-away app doesn't run tasks until it is opened again.
 *
 * The native modules are loaded defensively: if they fail, the app still starts and the
 * AI simply runs only while the app is open.
 */
import { bootstrap } from '../state/bootstrap';
import { controller } from '../state/controller';
import { engineStore } from '../state/engineStore';
import { quoteStore } from '../state/quoteStore';
import { aiRunner } from './runner';
import { aiStore } from './store';

export const AI_TASK = 'paperdalal-ai-trader';

type BackgroundTaskModule = typeof import('expo-background-task');
type TaskManagerModule = typeof import('expo-task-manager');

let BackgroundTask: BackgroundTaskModule | null = null;
let TaskManager: TaskManagerModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  TaskManager = require('expo-task-manager') as TaskManagerModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  BackgroundTask = require('expo-background-task') as BackgroundTaskModule;
} catch (e) {
  TaskManager = null;
  BackgroundTask = null;
  console.error('[PaperDalal] Background tasks unavailable:', e instanceof Error ? e.message : e);
}

// Must run in the global scope at startup, as expo-task-manager requires.
try {
  TaskManager?.defineTask(AI_TASK, async () => {
    const BT = BackgroundTask;
    try {
      await bootstrap({ background: true });
      // Fresh prices let the engine fill orders, trigger exits and judge market status.
      await controller.refresh();
      await aiRunner.maybeAutoRun('background');
      await aiRunner.settle();
      await engineStore.flush();
      await quoteStore.save();
      await aiStore.flush();
      return BT ? BT.BackgroundTaskResult.Success : undefined;
    } catch {
      return BT ? BT.BackgroundTaskResult.Failed : undefined;
    }
  });
} catch (e) {
  console.error('[PaperDalal] Could not define the background task:', e instanceof Error ? e.message : e);
}

export async function syncBackgroundTask(enabled: boolean): Promise<void> {
  const BT = BackgroundTask;
  const TM = TaskManager;
  if (!BT || !TM) return;
  try {
    const status = await BT.getStatusAsync();
    if (status !== BT.BackgroundTaskStatus.Available) return;
    const registered = await TM.isTaskRegisteredAsync(AI_TASK);
    if (enabled && !registered) await BT.registerTaskAsync(AI_TASK, { minimumInterval: 15 });
    if (!enabled && registered) await BT.unregisterTaskAsync(AI_TASK);
  } catch (e) {
    // Background work is a bonus; the AI also runs whenever the app is open.
    console.warn('[PaperDalal] Background task sync failed:', e instanceof Error ? e.message : e);
  }
}
