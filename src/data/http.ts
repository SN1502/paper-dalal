export class FeedError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** True when another host or source might succeed. */
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'FeedError';
  }
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    throw new FeedError(aborted ? 'Request timed out' : 'No internet connection or the server is unreachable', 0, true);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `worker` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const idx = next++;
      try {
        results[idx] = { status: 'fulfilled', value: await worker(items[idx]) };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
