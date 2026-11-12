/**
 * Keeps the screen on while Live mode is watching the market. Guarded like the other
 * native modules: if it can't load, Live mode still runs and the screen may sleep.
 */
type KeepAwakeModule = typeof import('expo-keep-awake');

const TAG = 'paperdalal-live';
let mod: KeepAwakeModule | null | undefined;
let active = false;

function load(): KeepAwakeModule | null {
  if (mod !== undefined) return mod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('expo-keep-awake') as KeepAwakeModule;
  } catch (e) {
    mod = null;
    console.error('[PaperDalal] Keep-awake unavailable:', e instanceof Error ? e.message : e);
  }
  return mod;
}

export function setKeepAwake(on: boolean) {
  if (on === active) return;
  const m = load();
  if (!m) return;
  active = on;
  const p = on ? m.activateKeepAwakeAsync(TAG) : m.deactivateKeepAwake(TAG);
  Promise.resolve(p).catch(() => {
    active = !on;
  });
}
