import type { OperationError, TypedOperationId } from "./generated/models.js";

export class KalshiApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: unknown;
  readonly headers: Headers;

  constructor(response: Response, body: unknown) {
    super(`Kalshi API request failed with HTTP ${response.status} ${response.statusText}`.trim());
    this.name = "KalshiApiError";
    this.status = response.status;
    this.statusText = response.statusText;
    this.body = body;
    this.headers = response.headers;
  }
}

export class KalshiEndpointError<I extends TypedOperationId> extends KalshiApiError {
  readonly operationId: I;
  readonly contract: OperationError<I>;
  constructor(operationId: I, response: Response, body: unknown) {
    super(response, body);
    this.name = "KalshiEndpointError";
    this.operationId = operationId;
    this.contract = { status: response.status, body } as OperationError<I>;
  }
}

export function isEndpointError<I extends TypedOperationId>(error: unknown, operationId: I): error is KalshiEndpointError<I> {
  return error instanceof KalshiEndpointError && error.operationId === operationId;
}

export class KalshiContractError extends Error {
  constructor(readonly operationId: string, readonly part: string, detail: string) {
    super(`${operationId} ${part}: ${detail}`);
    this.name = "KalshiContractError";
  }
}

export class KalshiInvalidResponseError extends KalshiApiError {
  constructor(error: KalshiApiError, readonly contractViolation: KalshiContractError) {
    super(new Response(null, {status: error.status, statusText: error.statusText, headers: error.headers}), error.body);
    this.name = "KalshiInvalidResponseError";
  }
}

export class KalshiOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KalshiOperationError";
  }
}

export class KalshiResponseParseError extends Error {
  constructor(readonly status: number) {
    super(`Kalshi response with HTTP ${status} contains invalid JSON.`);
    this.name = "KalshiResponseParseError";
  }
}

export class KalshiTransportError extends Error {
  constructor() { super("Kalshi HTTP transport failed."); this.name = "KalshiTransportError"; }
}

export class KalshiResponseReadError extends KalshiApiError {
  constructor(response: Response) {
    super(response, undefined);
    this.name = "KalshiResponseReadError";
    this.message = `Kalshi HTTP ${response.status} response body could not be read.`;
  }
}
