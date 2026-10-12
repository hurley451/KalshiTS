export interface WebSocketEnvelope<TMessage = unknown> {
  type: string;
  id?: number | undefined;
  sending_ts_ms?: number | undefined;
  sid?: number | undefined;
  seq?: number | undefined;
  msg?: TMessage | undefined;
}

export interface OrderBookDeltaMessage {
  market_ticker: string;
  market_id?: string;
  price?: number;
  delta?: number;
  price_dollars?: string;
  delta_fp?: string;
  side: string;
}

export function parseWebSocketMessage(payload: unknown): WebSocketEnvelope {
  const body = assertRecord(payload, "websocket message");
  const type = readRequiredString(body, "type");
  const message: WebSocketEnvelope = { type };
  for (const name of ["id", "sending_ts_ms", "sid", "seq"] as const) {
    if (body[name] !== undefined) {
      if (typeof body[name] !== "number" || !Number.isSafeInteger(body[name])) {
        throw new Error(`${name} must be a safe integer`);
      }
      message[name] = body[name];
    }
  }
  if ("msg" in body) {
    message.msg = body.msg;
  }
  return message;
}

function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readRequiredString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}
