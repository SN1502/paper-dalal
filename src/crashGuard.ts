/**
 * Keeps a JavaScript error from silently closing the app in release builds: fatal errors
 * are logged and shown on an error screen instead. Import this first in the root layout.
 */
type Listener = (e: Error) => void;

let fatal: Error | null = null;
const listeners = new Set<Listener>();

const g = globalThis as unknown as {
  ErrorUtils?: {
    getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
    setGlobalHandler(fn: (error: unknown, isFatal?: boolean) => void): void;
  };
  __paperdalalCrashGuard?: boolean;
};

if (g.ErrorUtils && !g.__paperdalalCrashGuard) {
  g.__paperdalalCrashGuard = true;
  const previous = g.ErrorUtils.getGlobalHandler();
  g.ErrorUtils.setGlobalHandler((error, isFatal) => {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`[PaperDalal] ${isFatal ? 'Fatal' : 'Unhandled'} error: ${err.message}\n${err.stack ?? ''}`);
    if (isFatal && !__DEV__) {
      fatal = err;
      for (const l of listeners) l(err);
      return;
    }
    previous(error, isFatal);
  });
}

export function getFatalError(): Error | null {
  return fatal;
}

export function onFatalError(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
