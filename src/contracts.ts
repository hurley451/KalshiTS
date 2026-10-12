import { contractComponents, operationContracts } from "./generated/contracts.js";
import { createContractRuntime } from "./contract-runtime.js";
import type { TypedOperationId } from "./generated/models.js";
export { endpointPath } from "./contract-runtime.js";
const runtime = createContractRuntime("kalshi-contract", contractComponents, operationContracts);
export const validateContract = runtime.validateContract;
export function validateEndpointInput(id: TypedOperationId, input: unknown): void { runtime.validateEndpointInput(id,input); }
export function validateEndpointResponse(id: TypedOperationId,status:number,value:unknown):boolean { return runtime.validateEndpointResponse(id,status,value); }
