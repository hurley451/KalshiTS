import { signKalshiRequest, type KalshiAuthOptions } from "./auth.js";
import { resolveEnvironment, type KalshiEnvironment, type KalshiEnvironmentName } from "./environment.js";
import { KalshiApiError, KalshiEndpointError, KalshiContractError, KalshiResponseParseError, KalshiTransportError, KalshiInvalidResponseError, KalshiResponseReadError } from "./errors.js";
import { TypedEndpoints } from "./generated/endpoints.js";
import { operationContracts } from "./generated/contracts.js";
import { endpointPath, validateEndpointInput, validateEndpointResponse } from "./contracts.js";
import type { EndpointOptions, TypedOperationId } from "./generated/models.js";
import { buildOperationPath, buildTradeApiPath, getOperation } from "./operation.js";
import { portfolioFillsQuery, parseFillsPage, type FillQuery, type FillsPage } from "./portfolio.js";
import type { OperationId } from "./generated/operations.js";
import type { JsonValue, PathParameters, QueryParameters } from "./types.js";
import { abortReason, delay, normalizeRetry, requestContext, RequestRateLimiter, retryDelay, withSignal, type RetryPolicy, type RateLimitPolicy } from "./transport.js";

export type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface KalshiClientOptions {
  readonly environment?: KalshiEnvironmentName | KalshiEnvironment | undefined;
  readonly auth?: KalshiAuthOptions | undefined;
  readonly fetch?: FetchImplementation | undefined;
  readonly defaultHeaders?: Record<string, string> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly retry?: RetryPolicy | undefined;
  readonly rateLimit?: RateLimitPolicy | undefined;
}

export interface KalshiRequestOptions {
  readonly pathParameters?: PathParameters | undefined;
  readonly query?: QueryParameters | undefined;
  readonly body?: JsonValue | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly authenticated?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface KalshiRawResponse<TBody = unknown> {
  readonly body: TBody;
  readonly response: Response;
}

export type PortfolioFacade = Omit<TypedEndpoints["portfolioApi"], "getFills"> & {
  getFills: (query?: FillQuery, options?: EndpointOptions) => Promise<FillsPage>;
  getFillsRaw: TypedEndpoints["getFills"];
};

export class KalshiClient extends TypedEndpoints {
  readonly environment: KalshiEnvironment;
  readonly #auth: KalshiAuthOptions | undefined;
  private readonly fetchImplementation: FetchImplementation;
  readonly #defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly retryPolicy: Required<RetryPolicy>;
  private readonly rateLimiter: RequestRateLimiter | undefined;

  constructor(options: KalshiClientOptions = {}) {
    super();
    this.environment = resolveEnvironment(options.environment);
    this.#auth = options.auth;
    this.fetchImplementation = options.fetch ?? fetch;
    this.#defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? 30000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 0 || this.timeoutMs > 2147483647) throw new RangeError("timeoutMs must be between 0 and 2147483647.");
    this.retryPolicy = normalizeRetry(options.retry);
    this.rateLimiter = options.rateLimit ? new RequestRateLimiter(options.rateLimit) : undefined;
  }

  async request<TBody = unknown>(
    operationId: OperationId | string,
    options: KalshiRequestOptions = {}
  ): Promise<TBody> {
    const { body } = await this.rawRequest<TBody>(operationId, options);
    return body;
  }

  async rawRequest<TBody = unknown>(
    operationId: OperationId | string,
    options: KalshiRequestOptions = {}
  ): Promise<KalshiRawResponse<TBody>> {
    const operation = getOperation(operationId);
    const pathAndQuery = buildOperationPath(operation, options.pathParameters, options.query);
    return this.send<TBody>(operation.method, pathAndQuery, options, operation.operationId);
  }

  readonly portfolio: PortfolioFacade = {
    ...this.portfolioApi,
    getFillsRaw: this.portfolioApi.getFills,
    getFills: async (query: FillQuery = {}, options: EndpointOptions = {}): Promise<FillsPage> => {
      const body = await this.request("GetFills", { ...options, query: portfolioFillsQuery(query) });
      return parseFillsPage(body);
    }
  };

  protected async executeTyped(id: TypedOperationId, inputValue?: unknown, options?: EndpointOptions): Promise<unknown> {
    const input = inputValue === undefined ? {} : inputValue;
    validateEndpointInput(id, input);
    const contract = operationContracts[id]!;
    const values = input as Record<string, unknown>;
    const headers = { ...(values.parameterHeaders as Record<string,string> ?? {}), ...options?.headers };
    if (values.cookies) headers.Cookie = Object.entries(values.cookies as Record<string,unknown>).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("; ");
    const request: KalshiRequestOptions = { ...options, authenticated: options?.authenticated ?? (contract.authenticated === true || this.#auth !== undefined), headers, ...(values.body === undefined ? {} : { body: values.body as JsonValue }) };
    try {
      const result = await this.send<unknown>(contract.method, endpointPath(contract, values), request, id);
      if (!validateEndpointResponse(id, result.response.status, result.body)) {
        throw new KalshiContractError(id, "response", `undeclared success status ${result.response.status}`);
      }
      return result.body;
    } catch (error) {
      if (error instanceof KalshiApiError) {
        if (error instanceof KalshiResponseReadError) throw error;
        let declared: boolean;
        try { declared = validateEndpointResponse(id, error.status, error.body); }
        catch (violation) {
          if (violation instanceof KalshiContractError) throw new KalshiInvalidResponseError(error, violation);
          throw violation;
        }
        if (declared) throw new KalshiEndpointError(id, new Response(null, { status: error.status, statusText: error.statusText, headers: error.headers }), error.body);
      }
      throw error;
    }
  }

  private async send<TBody>(
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
    const url = new URL(`${this.environment.restBaseUrl.replace(/\/$/, "")}${this.stripTradeApiPrefix(tradeApiPath)}`);
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
      for (const [name, value] of Object.entries(signKalshiRequest(this.#auth, method, tradeApiPath).headers)) {
        headers.set(name, value);
      }
    }

    let response: Response;
    try { response = await withSignal(this.fetchImplementation(url, init), signal); }
    catch { throw signal.aborted ? abortReason(signal) : new KalshiTransportError(); }
    let responseBody: unknown;
    try { responseBody = await withSignal(readResponseBody(response), signal); }
    catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (error instanceof KalshiResponseParseError) throw error;
      throw new KalshiResponseReadError(response);
    }
    if (!response.ok) {
      throw new KalshiApiError(response, responseBody);
    }
    return { body: responseBody as TBody, response };
  }

  private stripTradeApiPrefix(pathAndQuery: string): string {
    return pathAndQuery.replace(/^\/trade-api\/v2/, "");
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      if (response.ok) throw new KalshiResponseParseError(response.status);
      return text;
    }
  }
  return text;
}
