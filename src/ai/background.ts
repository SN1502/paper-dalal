/**
 * Lets the scheduled AI session run while the app is in the background.
 * The OS decides exact timing (Android WorkManager, at least every 15 minutes when
 * conditions allow); a swiped-away app doesn't run tasks until it is opened again.
 */
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { bootstrap } from '../state/bootstrap';
import { controller } from '../state/controller';
import { engineStore } from '../state/engineStore';
import { quoteStore } from '../state/quoteStore';
import { aiRunner } from './runner';
import { aiStore } from './store';

export const AI_TASK = 'paperdalal-ai-trader';

TaskManager.defineTask(AI_TASK, async () => {
  try {
    await bootstrap({ background: true });
    // Fresh prices let the engine fill orders, trigger exits and judge market status.
    await controller.refresh();
    await aiRunner.maybeAutoRun('background');
    await aiRunner.settle();
    await engineStore.flush();
    await quoteStore.save();
    await aiStore.flush();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function syncBackgroundTask(enabled: boolean): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
    const registered = await TaskManager.isTaskRegisteredAsync(AI_TASK);
    if (enabled && !registered) await BackgroundTask.registerTaskAsync(AI_TASK, { minimumInterval: 15 });
    if (!enabled && registered) await BackgroundTask.unregisterTaskAsync(AI_TASK);
  } catch {
    // Background work is a bonus; the AI also runs whenever the app is open.
  }
}
