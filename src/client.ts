import { signKalshiRequest, type KalshiAuthOptions } from "./auth.js";
import { resolveEnvironment, type KalshiEnvironment, type KalshiEnvironmentName } from "./environment.js";
import { KalshiApiError } from "./errors.js";
import { buildOperationPath, buildTradeApiPath, getOperation } from "./operation.js";
import { parseFillsPage, type FillQuery, type FillsPage } from "./portfolio.js";
import type { OperationId } from "./generated/operations.js";
import type { JsonValue, PathParameters, QueryParameters } from "./types.js";

export type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface KalshiClientOptions {
  readonly environment?: KalshiEnvironmentName | KalshiEnvironment | undefined;
  readonly auth?: KalshiAuthOptions | undefined;
  readonly fetch?: FetchImplementation | undefined;
  readonly defaultHeaders?: Record<string, string> | undefined;
}

export interface KalshiRequestOptions {
  readonly pathParameters?: PathParameters | undefined;
  readonly query?: QueryParameters | undefined;
  readonly body?: JsonValue | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly authenticated?: boolean | undefined;
}

export interface KalshiRawResponse<TBody = unknown> {
  readonly body: TBody;
  readonly response: Response;
}

export class KalshiClient {
  readonly environment: KalshiEnvironment;
  private readonly auth: KalshiAuthOptions | undefined;
  private readonly fetchImplementation: FetchImplementation;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: KalshiClientOptions = {}) {
    this.environment = resolveEnvironment(options.environment);
    this.auth = options.auth;
    this.fetchImplementation = options.fetch ?? fetch;
    this.defaultHeaders = options.defaultHeaders ?? {};
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
    return this.send<TBody>(operation.method, pathAndQuery, options);
  }

  readonly portfolio = {
    getFills: async (query: FillQuery = {}): Promise<FillsPage> => {
      const body = await this.request("GetFills", { query: portfolioFillsQuery(query) });
      return parseFillsPage(body);
    }
  };

  private async send<TBody>(
    method: string,
    operationPathAndQuery: string,
    options: KalshiRequestOptions
  ): Promise<KalshiRawResponse<TBody>> {
    const tradeApiPath = buildTradeApiPath(operationPathAndQuery);
    const url = new URL(`${this.environment.restBaseUrl.replace(/\/$/, "")}${this.stripTradeApiPrefix(tradeApiPath)}`);
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.defaultHeaders,
      ...options.headers
    };

    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
      init.body = JSON.stringify(options.body);
    }

    if (options.authenticated !== false) {
      if (!this.auth) {
        throw new Error("Authenticated Kalshi request requires auth options.");
      }
      Object.assign(headers, signKalshiRequest(this.auth, method, tradeApiPath).headers);
    }

    const response = await this.fetchImplementation(url, init);
    const responseBody = await readResponseBody(response);
    if (!response.ok) {
      throw new KalshiApiError(response, responseBody);
    }
    return { body: responseBody as TBody, response };
  }

  private stripTradeApiPrefix(pathAndQuery: string): string {
    return pathAndQuery.replace(/^\/trade-api\/v2/, "");
  }
}

function portfolioFillsQuery(query: FillQuery): QueryParameters {
  if (query.ticker && query.tickers && query.tickers.length > 0) {
    throw new Error("Specify either ticker or tickers, not both.");
  }
  if (query.tickers && query.tickers.length > 100) {
    throw new Error("At most 100 market tickers can be supplied.");
  }
  if (query.tickers?.some((value) => value.trim().length === 0)) {
    throw new Error("Market tickers cannot contain empty values.");
  }

  return {
    limit: query.limit,
    cursor: query.cursor,
    ticker: query.tickers && query.tickers.length > 0 ? query.tickers : query.ticker,
    order_id: query.orderId,
    subaccount: query.subaccount,
    exchange_index: query.exchangeIndex,
    min_ts: query.minTs,
    max_ts: query.maxTs
  };
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
    return JSON.parse(text);
  }
  return text;
}
