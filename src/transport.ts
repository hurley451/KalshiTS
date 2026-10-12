export interface RetryPolicy {
  /** Total attempts, including the initial request. Only GET requests retry. */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

export interface RateLimitPolicy {
  readonly capacity: number;
  readonly refillPerSecond: number;
  /** Local token cost, optionally populated from Kalshi endpoint-cost data. */
  readonly cost?: (operationId: string) => number;
}

export class KalshiTimeoutError extends Error {
  constructor() { super("Kalshi request timed out."); this.name = "KalshiTimeoutError"; }
}

export class KalshiAbortError extends Error {
  constructor() { super("Kalshi request canceled."); this.name = "KalshiAbortError"; }
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof KalshiTimeoutError ? signal.reason : new KalshiAbortError();
}

export function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // Attach a handler even when cancellation preceded this observation.
    void promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const aborted = () => reject(abortReason(signal));
    signal.addEventListener("abort", aborted, {once: true});
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(abortReason(signal)); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, ms);
    signal.addEventListener("abort", aborted, {once: true});
  });
}

export function requestContext(signal: AbortSignal | undefined, timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647) throw new RangeError("timeoutMs must be between 0 and 2147483647.");
  const controller = new AbortController();
  const canceled = () => controller.abort(new KalshiAbortError());
  if (signal?.aborted) canceled();
  else signal?.addEventListener("abort", canceled, {once: true});
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new KalshiTimeoutError()), timeoutMs) : undefined;
  return {signal: controller.signal, dispose() { clearTimeout(timer); signal?.removeEventListener("abort", canceled); }};
}

export function normalizeRetry(policy: RetryPolicy = {}): Required<RetryPolicy> {
  const value = {maxAttempts: policy.maxAttempts ?? 1, baseDelayMs: policy.baseDelayMs ?? 250, maxDelayMs: policy.maxDelayMs ?? 30000};
  if (!Number.isSafeInteger(value.maxAttempts) || value.maxAttempts < 1 || value.maxAttempts > 6) throw new RangeError("maxAttempts must be an integer from 1 to 6.");
  for (const key of ["baseDelayMs", "maxDelayMs"] as const) if (!Number.isFinite(value[key]) || value[key] < 0 || value[key] > 3600000) throw new RangeError(`${key} must be between 0 and 3600000.`);
  if (value.baseDelayMs > value.maxDelayMs) throw new RangeError("baseDelayMs must not exceed maxDelayMs.");
  return value;
}

export function retryDelay(policy: Required<RetryPolicy>, attempt: number, retryAfter: string | null): number | undefined {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  if (seconds === Infinity || seconds >= 0 && !Number.isFinite(seconds * 1000)) return undefined;
  const date = retryAfter === null ? NaN : Date.parse(retryAfter);
  const requested = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
  if (requested > policy.maxDelayMs) return undefined;
  return Math.max(requested, Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1)));
}

export class RequestRateLimiter {
  private tokens: number;
  private last = performance.now();
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly policy: RateLimitPolicy) {
    if (!Number.isFinite(policy.capacity) || policy.capacity <= 0 || !Number.isFinite(policy.refillPerSecond) || policy.refillPerSecond <= 0) throw new RangeError("Rate capacity and refillPerSecond must be positive finite numbers.");
    this.tokens = policy.capacity;
  }
  acquire(operationId: string, signal: AbortSignal): Promise<void> {
    const cost = this.policy.cost?.(operationId) ?? 1;
    if (!Number.isFinite(cost) || cost <= 0 || cost > this.policy.capacity) return Promise.reject(new RangeError("Request cost must be positive and no greater than rate capacity."));
    const turn = this.tail.then(async () => {
      for (;;) {
        if (signal.aborted) throw abortReason(signal);
        const now = performance.now();
        this.tokens = Math.min(this.policy.capacity, this.tokens + (now - this.last) * this.policy.refillPerSecond / 1000);
        this.last = now;
        if (this.tokens >= cost) { this.tokens -= cost; return; }
        const wait = Math.ceil((cost - this.tokens) * 1000 / this.policy.refillPerSecond);
        await delay(Math.min(2147483647, wait), signal);
      }
    });
    this.tail = turn.catch(() => {});
    return withSignal(turn, signal);
  }
}
