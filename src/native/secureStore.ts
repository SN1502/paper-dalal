/**
 * Secure key storage with a guarded native import: if the native module is missing or
 * fails to load, the app still starts and reports that secure storage is unavailable.
 */
type SecureStoreModule = typeof import('expo-secure-store');

let mod: SecureStoreModule | null | undefined;
let loadError: string | null = null;

function load(): SecureStoreModule | null {
  if (mod !== undefined) return mod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('expo-secure-store') as SecureStoreModule;
  } catch (e) {
    mod = null;
    loadError = e instanceof Error ? e.message : String(e);
    console.error('[PaperDalal] Secure storage unavailable:', loadError);
  }
  return mod;
}

export function secureStoreError(): string | null {
  load();
  return loadError;
}

export async function getSecret(key: string): Promise<string | null> {
  const m = load();
  if (!m) return null;
  return m.getItemAsync(key);
}

export async function setSecret(key: string, value: string): Promise<void> {
  const m = load();
  if (!m) throw new Error(`Secure storage isn’t available on this device: ${loadError ?? 'unknown error'}`);
  await m.setItemAsync(key, value, { keychainAccessible: m.AFTER_FIRST_UNLOCK });
}

export async function deleteSecret(key: string): Promise<void> {
  const m = load();
  if (!m) return;
  await m.deleteItemAsync(key);
}
