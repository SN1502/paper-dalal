/**
 * Minimal Claude Messages API client for React Native (plain fetch, no SDK).
 * Talks only to api.anthropic.com with the user's own API key.
 */

export const API_URL = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';

export type ModelId = 'claude-sonnet-5-5' | 'claude-opus-5-5' | 'claude-haiku-5-5';

export interface ModelInfo {
  id: ModelId;
  label: string;
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Published list prices (platform.claude.com/docs, checked Oct 2026); used only for cost estimates. */
export const MODELS: Record<ModelId, ModelInfo> = {
  'claude-sonnet-5-5': { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  'claude-opus-5-5': { id: 'claude-opus-5-5', label: 'Opus 5.5', input: 4, output: 20, cacheWrite: 5, cacheRead: 0.4 },
  'claude-haiku-5-5': { id: 'claude-haiku-5-5', label: 'Haiku 5.5', input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

export const WEB_SEARCH_USD = 0.01; // $10 per 1,000 searches

export type ContentBlock = { type: string; [k: string]: any };

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } | null;
}

export interface MessageResponse {
  id: string;
  model: string;
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'pause_turn' | 'max_tokens' | 'stop_sequence' | 'refusal' | string | null;
  usage: Usage;
}

export interface CreateParams {
  model: ModelId;
  max_tokens: number;
  system: ContentBlock[];
  tools: ContentBlock[];
  messages: Message[];
}

export class ClaudeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly kind: string,
  ) {
    super(message);
    this.name = 'ClaudeError';
  }
}

function friendly(status: number, kind: string, raw: string): string {
  if (status === 401) return 'Your Claude API key was rejected. Check it in AI settings.';
  if (status === 403) return 'This API key isn’t allowed to use this model or tool.';
  if (/credit balance/i.test(raw)) return 'Your Anthropic account is out of credits. Add credits in the Claude Console.';
  if (status === 429) return 'Claude rate limit reached. The run will retry later.';
  if (status === 529 || kind === 'overloaded_error') return 'Claude is overloaded right now. The run will retry later.';
  if (status >= 500) return 'Claude had a server error. The run will retry later.';
  return raw || `Claude request failed (${status}).`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ClientOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
}

async function request(path: string, init: RequestInit, opts: ClientOptions): Promise<any> {
  const f = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 3;
  let attempt = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new ClaudeError('Run stopped.', 0, 'aborted');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 240_000);
    let res: Response;
    try {
      res = await f(`${API_URL}${path}`, {
        ...init,
        headers: {
          'x-api-key': opts.apiKey,
          'anthropic-version': VERSION,
          'content-type': 'application/json',
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) throw new ClaudeError('Run stopped.', 0, 'aborted');
      if (attempt < retries) {
        attempt++;
        await sleep(1500 * attempt);
        continue;
      }
      throw new ClaudeError('Couldn’t reach Claude. Check your internet connection.', 0, 'network');
    }
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);

    if (res.ok) return res.json();

    const text = await res.text().catch(() => '');
    let kind = 'api_error';
    let message = text;
    try {
      const j = JSON.parse(text);
      kind = j?.error?.type ?? kind;
      message = j?.error?.message ?? text;
    } catch {
      // keep raw text
    }
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (retryable && attempt < retries) {
      attempt++;
      const after = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 2000 * attempt);
      continue;
    }
    throw new ClaudeError(friendly(res.status, kind, message), res.status, kind);
  }
}

/** Strips old cache markers and marks the last user block, so each turn reuses the cached prefix. */
export function withCacheBreakpoint(messages: Message[]): Message[] {
  const out = messages.map((m) => ({
    role: m.role,
    content: m.content.map((b) => {
      if (!('cache_control' in b)) return b;
      const { cache_control: _drop, ...rest } = b;
      return rest as ContentBlock;
    }),
  }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== 'user' || out[i].content.length === 0) continue;
    const blocks = [...out[i].content];
    const last = blocks[blocks.length - 1];
    if (last.type === 'text' || last.type === 'tool_result') {
      blocks[blocks.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
      out[i] = { ...out[i], content: blocks };
    }
    break;
  }
  return out;
}

export async function createMessage(params: CreateParams, opts: ClientOptions): Promise<MessageResponse> {
  return request(
    '/messages',
    { method: 'POST', body: JSON.stringify({ ...params, messages: withCacheBreakpoint(params.messages) }) },
    opts,
  );
}

/** Free call that confirms the key works. */
export async function verifyKey(apiKey: string, fetchImpl?: typeof fetch): Promise<void> {
  await request('/models?limit=1', { method: 'GET' }, { apiKey, fetchImpl, retries: 1, timeoutMs: 20_000 });
}

export function costOf(model: ModelId, u: Usage): number {
  const m = MODELS[model];
  const searches = u.server_tool_use?.web_search_requests ?? 0;
  return (
    (u.input_tokens * m.input +
      u.output_tokens * m.output +
      (u.cache_creation_input_tokens ?? 0) * m.cacheWrite +
      (u.cache_read_input_tokens ?? 0) * m.cacheRead) /
      1e6 +
    searches * WEB_SEARCH_USD
  );
}
