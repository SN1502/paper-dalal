/**
 * Daily close history for many symbols: batched through Yahoo's spark endpoint, with
 * per-symbol chart requests for anything the batch doesn't return.
 */
import { mapLimit } from './http';
import { yahooCandles, yahooHistoryBatch, type CloseHistory } from './yahoo';

const BATCH = 20;

export interface HistoryResult {
  history: Record<string, CloseHistory>;
  failed: string[];
}

/** A batch answer is only trusted if it has at least a year of bars. */
const longEnough = (h: CloseHistory | undefined) => !!h && h.c.length >= 200;

export async function fetchDailyHistory(
  symbols: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<HistoryResult> {
  const history: Record<string, CloseHistory> = {};
  let batchWorks = true;
  for (let i = 0; i < symbols.length && batchWorks; i += BATCH) {
    const chunk = symbols.slice(i, i + BATCH);
    try {
      const got = await yahooHistoryBatch(chunk, '2y');
      let useful = 0;
      for (const s of chunk) {
        if (longEnough(got[s])) {
          history[s] = got[s];
          useful++;
        }
      }
      // If the first batch returns nothing usable, the endpoint isn't serving history: stop using it.
      if (i === 0 && useful === 0) batchWorks = false;
    } catch {
      if (i === 0) batchWorks = false;
    }
    onProgress?.(Object.keys(history).length, symbols.length);
  }

  const rest = symbols.filter((s) => !history[s]);
  const failed: string[] = [];
  await mapLimit(rest, 4, async (s) => {
    try {
      const series = await yahooCandles(s, '2y', '1d');
      if (series.candles.length >= 60) history[s] = { t: series.candles.map((c) => c.t), c: series.candles.map((c) => c.c) };
      else failed.push(s);
    } catch {
      failed.push(s);
    }
    onProgress?.(Object.keys(history).length, symbols.length);
  });
  return { history, failed };
}
