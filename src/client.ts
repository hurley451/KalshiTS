import type { KalshiAuthOptions } from "./auth.js";
import { resolveEnvironment, type KalshiEnvironment, type KalshiEnvironmentName } from "./environment.js";
import { KalshiApiError, KalshiEndpointError, KalshiContractError, KalshiInvalidResponseError, KalshiResponseReadError } from "./errors.js";
import { TypedEndpoints } from "./generated/endpoints.js";
import { operationContracts } from "./generated/contracts.js";
import { endpointPath, validateEndpointInput, validateEndpointResponse } from "./contracts.js";
import type { EndpointOptions, TypedOperationId } from "./generated/models.js";
import { buildOperationPath, getOperation } from "./operation.js";
import { portfolioFillsQuery, parseFillsPage, type FillQuery, type FillsPage } from "./portfolio.js";
import type { OperationId } from "./generated/operations.js";
import type { JsonValue, PathParameters, QueryParameters } from "./types.js";
import type { RetryPolicy, RateLimitPolicy } from "./transport.js";
import { HttpExecutor } from "./http-executor.js";

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
  readonly rawBody: Uint8Array;
}

export type PortfolioFacade = Omit<TypedEndpoints["portfolioApi"], "getFills"> & {
  getFills: (query?: FillQuery, options?: EndpointOptions) => Promise<FillsPage>;
  getFillsRaw: TypedEndpoints["getFills"];
};

export class KalshiClient extends TypedEndpoints {
  readonly environment: KalshiEnvironment;
  readonly #auth: KalshiAuthOptions | undefined;
  private readonly executor: HttpExecutor;

  constructor(options: KalshiClientOptions = {}) {
    super();
    this.environment = resolveEnvironment(options.environment);
    this.#auth = options.auth;
    this.executor = new HttpExecutor({ ...options, restBaseUrl: this.environment.restBaseUrl });
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
    return this.executor.send<TBody>(operation.method, pathAndQuery, options, operation.operationId);
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
      const result = await this.executor.send<unknown>(contract.method, endpointPath(contract, values), request, id);
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
        if (declared) throw new KalshiEndpointError(id, new Response(null, { status: error.status, statusText: error.statusText, headers: error.headers }), error.body, error.rawBody);
      }
      throw error;
    }
  }

}
