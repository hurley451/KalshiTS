import { createContractRuntime } from "./contract-runtime.js";
import { perpsContractComponents, perpsSourceComponents, perpsOperationContracts } from "./generated/perps-rest/contracts.js";
import type { PerpsOperationId } from "./generated/perps-rest/models.js";
import { KalshiContractError } from "./errors.js";

const contextId = (id: string) => `perps_openapi:${id}`;
const active = createContractRuntime("urn:kalshi:perps-openapi:active:2026-10-12", perpsContractComponents, perpsOperationContracts, contextId);
const source = createContractRuntime("urn:kalshi:perps-openapi:raw", perpsSourceComponents, perpsOperationContracts, contextId);
export const validatePerpsContract = active.validateContract;
export const validatePerpsSourceContract = source.validateContract;
export function validatePerpsEndpointResponse(id: PerpsOperationId, status: number, value: unknown): boolean {
  if (!Object.hasOwn(perpsOperationContracts,id)) throw new KalshiContractError(contextId(id),"response","unknown operation");
  return active.validateEndpointResponse(id,status,value);
}
export function validatePerpsEndpointInput(id: PerpsOperationId, input: unknown): void {
  if (!Object.hasOwn(perpsOperationContracts,id)) throw new KalshiContractError(`perps_openapi:${id}`,"input","unknown operation");
  const parts = typeof input === "object" && input !== null ? input as {body?:Record<string,unknown>;query?:Record<string,unknown>} : {};
  const body = parts.body;
  const reject = (pointer: string, detail: string): never => { throw new KalshiContractError(`perps_openapi:${id}`,pointer,detail); };
  if (id === "IntraExchangeInstanceTransfer" && body && Object.hasOwn(body,"client_transfer_id")) {
    reject("#/components/schemas/IntraExchangeInstanceTransferRequest/properties/client_transfer_id","future field effective 2026-10-15; active profile 2026-10-12");
  }
  if (id === "GetMarginTrades" && parts.query && Object.hasOwn(parts.query,"ticker")) reject("#/paths/~1margin~1trades/get/parameters/0","future ticker filter effective 2026-10-15; active profile 2026-10-12");
  if (id === "CreateMarginOrder" && body) {
    if (body.ticker == null && body.market_id == null) reject("#/components/schemas/CreateMarginOrderRequest/properties/ticker","ticker or market_id required; both permitted with ticker precedence");
    if (body.reduce_only === true && !["immediate_or_cancel","fill_or_kill"].includes(String(body.time_in_force))) reject("#/components/schemas/CreateMarginOrderRequest/properties/reduce_only","reduce_only requires immediate_or_cancel or fill_or_kill");
  }
  if (id === "DecreaseMarginOrder" && body && [body.reduce_by,body.reduce_to].filter(v=>v!=null).length !== 1) reject("#/components/schemas/DecreaseMarginOrderRequest","exactly one non-null reduce_by/reduce_to required");
  active.validateEndpointInput(id,input);
}
