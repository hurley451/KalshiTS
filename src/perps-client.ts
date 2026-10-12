import type { KalshiClientOptions, KalshiRequestOptions } from "./client.js";
import { HttpExecutor } from "./http-executor.js";
import { PerpsTypedEndpoints } from "./generated/perps-rest/endpoints.js";
import { perpsOperationContracts } from "./generated/perps-rest/contracts.js";
import type { PerpsOperationId } from "./generated/perps-rest/models.js";
import type { EndpointOptions } from "./endpoint-options.js";
import { endpointPath } from "./contract-runtime.js";
import { validatePerpsEndpointInput, validatePerpsEndpointResponse } from "./perps-contracts.js";
import { KalshiApiError, KalshiContractError, KalshiInvalidResponseError, KalshiResponseReadError } from "./errors.js";
import { KalshiPerpsEndpointError } from "./perps-errors.js";
import { resolvePerpsEnvironment, type KalshiPerpsEnvironment, type KalshiPerpsEnvironmentName } from "./perps-environment.js";
import type { JsonValue } from "./types.js";

export interface KalshiPerpsClientOptions extends Omit<KalshiClientOptions,"environment"> {
  readonly environment?: KalshiPerpsEnvironmentName | KalshiPerpsEnvironment | undefined;
}
export class KalshiPerpsClient extends PerpsTypedEndpoints {
  readonly environment: KalshiPerpsEnvironment;
  readonly #executor: HttpExecutor;
  readonly #hasAuth: boolean;
  constructor(options: KalshiPerpsClientOptions = {}) {
    super();
    this.environment = resolvePerpsEnvironment(options.environment);
    this.#executor = new HttpExecutor({...options,restBaseUrl:this.environment.restBaseUrl});
    this.#hasAuth = options.auth !== undefined;
  }
  protected async executeTyped(id: PerpsOperationId, inputValue?: unknown, options?: EndpointOptions): Promise<unknown> {
    const input = inputValue === undefined ? {} : inputValue;
    validatePerpsEndpointInput(id,input);
    const contract = perpsOperationContracts[id]!;
    const values = input as Record<string,unknown>;
    const headers = {...values.parameterHeaders as Record<string,string> ?? {}, ...options?.headers};
    if(values.cookies) headers.Cookie = Object.entries(values.cookies as Record<string,unknown>).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("; ");
    const request: KalshiRequestOptions = {...options,authenticated:options?.authenticated ?? (contract.authenticated === true || this.#hasAuth),headers,...(values.body===undefined?{}:{body:values.body as JsonValue})};
    try {
      const result = await this.#executor.send(contract.method,endpointPath(contract,values),request,`perps_openapi:${id}`);
      if(!validatePerpsEndpointResponse(id,result.response.status,result.body)) throw new KalshiContractError(`perps_openapi:${id}`,"response",`undeclared success status ${result.response.status}`);
      return result.body;
    } catch(error) {
      if(error instanceof KalshiApiError) {
        if(error instanceof KalshiResponseReadError) throw error;
        let declared: boolean;
        try {declared=validatePerpsEndpointResponse(id,error.status,error.body);}
        catch(violation) {if(violation instanceof KalshiContractError) throw new KalshiInvalidResponseError(error,violation);throw violation;}
        if(declared) throw new KalshiPerpsEndpointError(id,new Response(null,{status:error.status,statusText:error.statusText,headers:error.headers}),error.body,error.rawBody);
      }
      throw error;
    }
  }
}
