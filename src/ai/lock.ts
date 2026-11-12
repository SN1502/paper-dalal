/**
 * One AI session at a time: scheduled swing sessions and Live-mode decisions both place
 * orders on the same account, so they never overlap.
 */
let holder: string | null = null;

export const aiLock = {
  holder: () => holder,
  tryAcquire(name: string): boolean {
    if (holder !== null) return false;
    holder = name;
    return true;
  },
  release(name: string) {
    if (holder === name) holder = null;
  },
};
