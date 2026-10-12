import { KalshiApiError } from "./errors.js";
import type { PerpsOperationId, PerpsOperationError } from "./generated/perps-rest/models.js";

export class KalshiPerpsEndpointError<I extends PerpsOperationId> extends KalshiApiError {
  readonly sourceId = "perps_openapi";
  readonly contract: PerpsOperationError<I>;
  constructor(readonly operationId: I, response: Response, body: unknown, rawBody?: Uint8Array) {
    super(response, body, rawBody);
    this.name = "KalshiPerpsEndpointError";
    this.contract = {status: response.status, body} as PerpsOperationError<I>;
  }
}
export function isPerpsEndpointError<I extends PerpsOperationId>(error: unknown, operationId: I): error is KalshiPerpsEndpointError<I> {
  return error instanceof KalshiPerpsEndpointError && error.operationId === operationId;
}
