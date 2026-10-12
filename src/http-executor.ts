import { signKalshiRequest, type KalshiAuthOptions } from "./auth.js";
import { KalshiApiError, KalshiResponseParseError, KalshiTransportError, KalshiResponseReadError } from "./errors.js";
import { buildTradeApiPath } from "./operation.js";
import { abortReason, delay, normalizeRetry, requestContext, RequestRateLimiter, retryDelay, withSignal, type RetryPolicy, type RateLimitPolicy } from "./transport.js";
import type { FetchImplementation, KalshiRequestOptions, KalshiRawResponse } from "./client.js";
export interface HttpExecutorOptions {
 restBaseUrl: string; auth?: KalshiAuthOptions | undefined; fetch?: FetchImplementation | undefined; defaultHeaders?: Record<string,string> | undefined; timeoutMs?: number | undefined; retry?: RetryPolicy | undefined; rateLimit?: RateLimitPolicy | undefined;
}
export class HttpExecutor {
 readonly #auth: KalshiAuthOptions | undefined;
 readonly #defaultHeaders: Record<string,string>;
 private readonly fetchImplementation: FetchImplementation;
 private readonly timeoutMs: number;
 private readonly retryPolicy: Required<RetryPolicy>;
 private readonly rateLimiter: RequestRateLimiter | undefined;
 private readonly restBaseUrl: string;
 constructor(options: HttpExecutorOptions) {
 this.restBaseUrl = options.restBaseUrl;
 this.#auth = options.auth;
 this.fetchImplementation = options.fetch ?? fetch;
 this.#defaultHeaders = options.defaultHeaders ?? {};
 this.timeoutMs = options.timeoutMs ?? 30000;
 if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 0 || this.timeoutMs > 2147483647) throw new RangeError("timeoutMs must be between 0 and 2147483647.");
 this.retryPolicy = normalizeRetry(options.retry);
 this.rateLimiter = options.rateLimit ? new RequestRateLimiter(options.rateLimit) : undefined;
 }
  async send<TBody>(
    method: string,
    operationPathAndQuery: string,
    options: KalshiRequestOptions,
    operationId: string
  ): Promise<KalshiRawResponse<TBody>> {
    const context = requestContext(options.signal, options.timeoutMs ?? this.timeoutMs);
    try {
      for (let attempt = 1; ; attempt++) {
        if (context.signal.aborted) throw abortReason(context.signal);
        await this.rateLimiter?.acquire(operationId, context.signal);
        if (context.signal.aborted) throw abortReason(context.signal);
        try {
          return await this.sendOnce<TBody>(method, operationPathAndQuery, options, context.signal);
        } catch (error) {
          if (context.signal.aborted) throw abortReason(context.signal);
          const retryable = error instanceof KalshiTransportError || error instanceof KalshiResponseReadError || error instanceof KalshiApiError && [408, 429, 500, 502, 503, 504].includes(error.status);
          if (method !== "GET" || !retryable || attempt >= this.retryPolicy.maxAttempts) throw error;
          const backoff = retryDelay(this.retryPolicy, attempt, error instanceof KalshiApiError ? error.headers.get("retry-after") : null);
          if (backoff === undefined) throw error;
          await delay(backoff, context.signal);
        }
      }
    } finally { context.dispose(); }
  }

  private async sendOnce<TBody>(
    method: string,
    operationPathAndQuery: string,
    options: KalshiRequestOptions,
    signal: AbortSignal
  ): Promise<KalshiRawResponse<TBody>> {
    const tradeApiPath = buildTradeApiPath(operationPathAndQuery);
    const url = new URL(`${this.restBaseUrl.replace(/\/$/, "")}${this.stripTradeApiPrefix(tradeApiPath)}`);
    const headers = new Headers({ Accept: "application/json" });
    for (const source of [this.#defaultHeaders, options.headers ?? {}]) {
      for (const [name, value] of Object.entries(source)) headers.set(name, value);
    }

    const init: RequestInit = { method, headers, signal, redirect: "error" };
    if (options.body !== undefined) {
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(options.body);
    }

    if (options.authenticated !== false) {
      if (!this.#auth) {
        throw new Error("Authenticated Kalshi request requires auth options.");
      }
      for (const [name, value] of Object.entries(signKalshiRequest(this.#auth, method, url.pathname).headers)) {
        headers.set(name, value);
      }
    }

    let response: Response;
    try { response = await withSignal(this.fetchImplementation(url, init), signal); }
    catch { throw signal.aborted ? abortReason(signal) : new KalshiTransportError(); }
    let decoded: {body: unknown; rawBody: Uint8Array};
    try { decoded = await withSignal(readResponseBody(response), signal); }
    catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (error instanceof KalshiResponseParseError) throw error;
      throw new KalshiResponseReadError(response);
    }
    if (!response.ok) {
      throw new KalshiApiError(response, decoded.body, decoded.rawBody);
    }
    return { body: decoded.body as TBody, response, rawBody: decoded.rawBody };
  }

  private stripTradeApiPrefix(pathAndQuery: string): string {
    return pathAndQuery.replace(/^\/trade-api\/v2/, "");
  }
}

async function readResponseBody(response: Response): Promise<{body: unknown; rawBody: Uint8Array}> {
  const rawBody = new Uint8Array(await response.arrayBuffer());
  if (response.status === 204 || rawBody.length === 0) return {body: undefined, rawBody};
  const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  const json = contentType === "application/json" || contentType.endsWith("+json");
  let text: string;
  try { text = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(rawBody); }
  catch {
    if (json && response.ok) throw new KalshiResponseParseError(response.status, response.headers, rawBody);
    return {body: rawBody.slice(), rawBody};
  }
  if (contentType === "application/octet-stream") return {body: rawBody.slice(), rawBody};
  if (json) {
    try {
      return {body: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text), rawBody};
    } catch {
      if (response.ok) throw new KalshiResponseParseError(response.status, response.headers, rawBody);
      return {body: text, rawBody};
    }
  }
  return {body: text, rawBody};
}
