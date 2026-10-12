import type { OperationError, TypedOperationId } from "./generated/models.js";
import { inspect } from "node:util";

export class KalshiAuthError extends Error {
  constructor(message: string) { super(message); this.name = "KalshiAuthError"; }
}

export class KalshiApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: unknown;
  readonly headers: Headers;
  readonly rawBody: Uint8Array | undefined;

  constructor(response: Response, body: unknown, rawBody?: Uint8Array) {
    super(`Kalshi API request failed with HTTP ${response.status}`);
    this.name = "KalshiApiError";
    this.status = response.status;
    this.statusText = response.statusText;
    this.body = body;
    this.headers = response.headers;
    this.rawBody = rawBody;
  }

  [inspect.custom](): string { return `${this.name}: ${this.message}`; }
  toJSON() { return {name: this.name, message: this.message, status: this.status}; }
}

export class KalshiEndpointError<I extends TypedOperationId> extends KalshiApiError {
  readonly operationId: I;
  readonly contract: OperationError<I>;
  constructor(operationId: I, response: Response, body: unknown, rawBody?: Uint8Array) {
    super(response, body, rawBody);
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
    super(new Response(null, {status: error.status, statusText: error.statusText, headers: error.headers}), error.body, error.rawBody);
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
  constructor(readonly status: number, readonly headers?: Headers, readonly rawBody?: Uint8Array) {
    super(`Kalshi response with HTTP ${status} contains invalid JSON.`);
    this.name = "KalshiResponseParseError";
  }
  [inspect.custom](): string { return `${this.name}: ${this.message}`; }
  toJSON() { return {name: this.name, message: this.message, status: this.status}; }
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
