import { serializeQuery } from "./operation.js";
import type { QueryParameters } from "./types.js";

export interface FillQuery {
  ticker?: string | undefined;
  tickers?: readonly string[] | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  orderId?: string | undefined;
  minTs?: number | undefined;
  maxTs?: number | undefined;
  subaccount?: number | undefined;
  exchangeIndex?: number | undefined;
}

export interface Fill {
  fillId: string;
  exchangeIndex: number;
  tradeId: string;
  orderId: string;
  ticker: string;
  marketTicker: string;
  outcomeSide: "yes" | "no";
  bookSide: "bid" | "ask";
  countFp: string;
  yesPriceDollars: string;
  noPriceDollars: string;
  feeCost: string;
  side?: "yes" | "no" | undefined;
  action?: "buy" | "sell" | undefined;
  isTaker: boolean;
  createdTime?: string | undefined;
  subaccountNumber?: number | null | undefined;
  ts?: number | undefined;
}

export interface FillsPage {
  fills: Fill[];
  cursor: string;
}

export function buildPortfolioFillsPath(query: FillQuery = {}): string {
  const serialized = serializeQuery(portfolioFillsQuery(query));
  return `/trade-api/v2/portfolio/fills${serialized ? `?${serialized}` : ""}`;
}

export function portfolioFillsQuery(query: FillQuery = {}): QueryParameters {
  validateInteger(query.limit, "limit", 1, 1000);
  validateInteger(query.subaccount, "subaccount", 0, 63);
  validateInteger(query.exchangeIndex, "exchangeIndex", 0);
  validateInteger(query.minTs, "minTs");
  validateInteger(query.maxTs, "maxTs");
  return {
    limit: query.limit,
    cursor: query.cursor,
    ticker: resolveTickerFilter(query.ticker, query.tickers),
    order_id: query.orderId,
    subaccount: query.subaccount,
    exchange_index: query.exchangeIndex,
    min_ts: query.minTs,
    max_ts: query.maxTs
  };

}

export function parseFillsPage(payload: unknown): FillsPage {
  const body = assertRecord(payload, "fills response");
  const rawFills = body.fills;
  if (!Array.isArray(rawFills)) {
    throw new Error("fills response must contain a fills array");
  }

  return {
    fills: rawFills.map(parseFill),
    cursor: readRequiredString(body, "cursor")
  };
}

function parseFill(payload: unknown): Fill {
  const body = assertRecord(payload, "fill");
  return {
    fillId: readRequiredString(body, "fill_id"),
    exchangeIndex: readInteger(body, "exchange_index"),
    tradeId: readRequiredString(body, "trade_id"),
    orderId: readRequiredString(body, "order_id"),
    ticker: readRequiredString(body, "ticker"),
    marketTicker: readRequiredString(body, "market_ticker"),
    outcomeSide: readEnum(body, "outcome_side", ["yes", "no"]),
    bookSide: readEnum(body, "book_side", ["bid", "ask"]),
    countFp: readRequiredString(body, "count_fp"),
    yesPriceDollars: readRequiredString(body, "yes_price_dollars"),
    noPriceDollars: readRequiredString(body, "no_price_dollars"),
    feeCost: readRequiredString(body, "fee_cost"),
    side: body.side === undefined ? undefined : readEnum(body, "side", ["yes", "no"]),
    action: body.action === undefined ? undefined : readEnum(body, "action", ["buy", "sell"]),
    isTaker: readRequiredBoolean(body, "is_taker"),
    createdTime: readOptionalString(body, "created_time"),
    subaccountNumber: body.subaccount_number === null ? null : readOptionalNumber(body, "subaccount_number"),
    ts: readOptionalNumber(body, "ts")
  };
}

function resolveTickerFilter(ticker?: string, tickers?: readonly string[]): string | readonly string[] | undefined {
  if (ticker !== undefined && tickers !== undefined) {
    throw new Error("Specify either ticker or tickers, not both.");
  }
  if (ticker !== undefined && ticker.trim().length === 0) throw new Error("Market ticker cannot be empty.");
  if (tickers !== undefined) {
    if (tickers.length === 0) throw new Error("Market tickers cannot be empty.");
    if (tickers.length > 100) {
      throw new Error("At most 100 market tickers can be supplied.");
    }
    if (tickers.some((value) => value.trim().length === 0)) {
      throw new Error("Market tickers cannot contain empty values.");
    }
    return tickers;
  }
  return ticker;
}

function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readRequiredString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function readOptionalString(body: Record<string, unknown>, name: string): string | undefined {
  return body[name] === undefined ? undefined : readRequiredString(body, name);
}

function readRequiredBoolean(body: Record<string, unknown>, name: string): boolean {
  const value = body[name];
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function readOptionalNumber(body: Record<string, unknown>, name: string): number | undefined {
  return body[name] === undefined ? undefined : readInteger(body, name);
}

function readInteger(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
  return value;
}

function readEnum<const T extends string>(body: Record<string, unknown>, name: string, values: readonly T[]): T {
  const value = readRequiredString(body, name);
  if (!values.includes(value as T)) throw new Error(`${name} must be one of ${values.join(", ")}`);
  return value as T;
}

function validateInteger(value: number | undefined, name: string, minimum?: number, maximum?: number): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) {
    throw new Error(`${name} must be a safe integer${minimum === undefined ? "" : ` >= ${minimum}`}${maximum === undefined ? "" : ` <= ${maximum}`}`);
  }
}
