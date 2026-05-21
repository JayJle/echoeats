// 统一的重试 + 超时工具。Worker 友好，无外部依赖。
// 仅对 5xx / 429 / 网络层错误重试；4xx 不重试（参数错就是参数错，重试也没用）。

export type RetryOptions = {
  retries?: number;        // 重试次数（不含首次）。默认 1。
  baseMs?: number;         // 首次退避基数。默认 400ms。
  timeoutMs?: number;      // 单次调用超时；undefined = 不设。
  label: string;           // 日志前缀。
  shouldRetry?: (err: unknown) => boolean;
};

// 给 fetch 之类的 API 包一层超时；调用方在 fn(signal) 里把 signal 传给 fetch。
export type WithRetryFn<T> = (signal: AbortSignal | undefined) => Promise<T>;

const DEFAULT_RETRYABLE = (err: unknown): boolean => {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  // HTTP 5xx / 429
  if (/\b(5\d\d|429)\b/.test(msg)) return true;
  // AbortError（我们的超时）
  if (/abort/i.test(msg)) return true;
  // 网络层（DNS / TLS / 连接重置）
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(msg)) return true;
  return false;
};

export async function withRetry<T>(
  fn: WithRetryFn<T>,
  opts: RetryOptions,
): Promise<T> {
  const retries = opts.retries ?? 1;
  const baseMs = opts.baseMs ?? 400;
  const shouldRetry = opts.shouldRetry ?? DEFAULT_RETRYABLE;
  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= retries) {
    const started = Date.now();
    let signal: AbortSignal | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const ac = new AbortController();
      signal = ac.signal;
      timer = setTimeout(() => ac.abort(new Error(`timeout ${opts.timeoutMs}ms`)), opts.timeoutMs);
    }
    try {
      const result = await fn(signal);
      if (attempt > 0) {
        console.log(`[retry:${opts.label}] ok after ${attempt} retry in ${Date.now() - started}ms`);
      }
      return result;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const willRetry = attempt < retries && shouldRetry(err);
      console.warn(
        `[retry:${opts.label}] attempt=${attempt + 1}/${retries + 1} ms=${Date.now() - started} err=${msg.slice(0, 160)}${willRetry ? " → retry" : " → give up"}`,
      );
      if (!willRetry) throw err;
      // 指数退避 + 抖动
      const delay = baseMs * 2 ** attempt + Math.floor(Math.random() * 150);
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastErr;
}
