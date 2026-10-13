import type { KalshiRawResponse, KalshiRequestOptions } from "./client.js";
import type { EndpointOptions } from "./endpoint-options.js";
import { KalshiApiError, KalshiContractError, KalshiInvalidResponseError } from "./errors.js";
import { cfPath, cfQueryRecord } from "./cf-contracts.js";
import type { CfEnvelope, CfOperationId, CfQueryPairs, CfValuesQuery, CfHistoryValuesQuery } from "./generated/cf-rest/models.js";

export interface CfRequestOptions extends EndpointOptions {
  providerPath?: string;
  queryPairs?: CfQueryPairs;
  body?: never;
}
type Send = (method: string, path: string, options: KalshiRequestOptions, id: string) => Promise<KalshiRawResponse<unknown>>;

export class CfBenchmarksClient {
  constructor(private readonly send: Send, private readonly restBaseUrl: string) {}

  async execute(id: CfOperationId, options: CfRequestOptions = {}): Promise<KalshiRawResponse<CfEnvelope>> {
    const values = options as Record<string, unknown>;
    const fixed = id === "cfbenchmarks.values" ? "values" : id === "cfbenchmarks.history-values" ? "history/values" : undefined;
    if (Object.hasOwn(values, "body") || Object.hasOwn(values, "query") || Object.hasOwn(values, "pathParameters")
      || fixed !== undefined && Object.hasOwn(values, "providerPath")) {
      throw new KalshiContractError(`cfbenchmarks-rest-manual:${id}`, "request", "body and route overrides are forbidden");
    }
    const path = cfPath(id, fixed ?? options.providerPath, options.queryPairs === undefined ? [] : options.queryPairs);
    const base = new URL(this.restBaseUrl);
    const suffix = path.replace(/^\/trade-api\/v2/, "");
    const final = new URL(this.restBaseUrl.replace(/\/$/, "") + suffix);
    const expectedPath = base.pathname.replace(/\/$/, "") + suffix.split("?", 1)[0];
    if (base.search || base.hash || final.origin !== base.origin || final.pathname !== expectedPath) {
      throw new KalshiContractError(`cfbenchmarks-rest-manual:${id}`, "providerPath", "configured root does not confine CF path");
    }
    const snapshot: KalshiRequestOptions = { ...options, ...(options.headers ? { headers: { ...options.headers } } : {}) };
    const result = await this.send("GET", path, snapshot, `cfbenchmarks-rest-manual:${id}`);
    const body = result.body;
    if (result.response.status !== 200 || body === null || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, "data")) {
      throw new KalshiInvalidResponseError(new KalshiApiError(result.response, body, result.rawBody),
        new KalshiContractError(`cfbenchmarks-rest-manual:${id}`, "response", "expected HTTP 200 with an open data envelope"));
    }
    return result as KalshiRawResponse<CfEnvelope>;
  }

  getRaw(providerPath: string, queryPairs: CfQueryPairs = [], options: EndpointOptions = {}) {
    return this.execute("cfbenchmarks.passthrough", { ...options, providerPath, queryPairs });
  }
  async get(providerPath: string, queryPairs: CfQueryPairs = [], options: EndpointOptions = {}): Promise<CfEnvelope> {
    return (await this.getRaw(providerPath, queryPairs, options)).body;
  }
  valuesRaw(query: CfValuesQuery | CfQueryPairs = [], options: EndpointOptions = {}) {
    return this.execute("cfbenchmarks.values", { ...options, queryPairs: cfQueryRecord(query) });
  }
  async values(query: CfValuesQuery | CfQueryPairs = [], options: EndpointOptions = {}): Promise<CfEnvelope> {
    return (await this.valuesRaw(query, options)).body;
  }
  historyValuesRaw(query: CfHistoryValuesQuery | CfQueryPairs = [], options: EndpointOptions = {}) {
    return this.execute("cfbenchmarks.history-values", { ...options, queryPairs: cfQueryRecord(query) });
  }
  async historyValues(query: CfHistoryValuesQuery | CfQueryPairs = [], options: EndpointOptions = {}): Promise<CfEnvelope> {
    return (await this.historyValuesRaw(query, options)).body;
  }
}
