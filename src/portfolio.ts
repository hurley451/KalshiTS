import { serializeQuery } from "./operation.js";

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
  fillId?: string | undefined;
  exchangeIndex?: number | undefined;
  tradeId: string;
  orderId: string;
  ticker: string;
  marketTicker?: string | undefined;
  outcomeSide?: string | undefined;
  bookSide?: string | undefined;
  countFp?: string | undefined;
  yesPriceDollars?: string | undefined;
  noPriceDollars?: string | undefined;
  feeCost?: string | undefined;
  side: string;
  action?: string | undefined;
  isTaker: boolean;
  createdTime: string;
  subaccountNumber?: number | undefined;
  ts?: number | undefined;
}

export interface FillsPage {
  fills: Fill[];
  cursor?: string | null | undefined;
}

export function buildPortfolioFillsPath(query: FillQuery = {}): string {
  const params = {
    limit: query.limit,
    cursor: query.cursor,
    ticker: resolveTickerFilter(query.ticker, query.tickers),
    order_id: query.orderId,
    subaccount: query.subaccount,
    exchange_index: query.exchangeIndex,
    min_ts: query.minTs,
    max_ts: query.maxTs
  };

  const serialized = serializeQuery(params);
  return `/trade-api/v2/portfolio/fills${serialized ? `?${serialized}` : ""}`;
}

export function parseFillsPage(payload: unknown): FillsPage {
  const body = assertRecord(payload, "fills response");
  const rawFills = body.fills;
  if (!Array.isArray(rawFills)) {
    throw new Error("fills response must contain a fills array");
  }

  return {
    fills: rawFills.map(parseFill),
    cursor: typeof body.cursor === "string" || body.cursor === null ? body.cursor : undefined
  };
}

function parseFill(payload: unknown): Fill {
  const body = assertRecord(payload, "fill");
  return {
    fillId: readOptionalString(body, "fill_id"),
    exchangeIndex: readOptionalNumber(body, "exchange_index"),
    tradeId: readRequiredString(body, "trade_id"),
    orderId: readRequiredString(body, "order_id"),
    ticker: readRequiredString(body, "ticker"),
    marketTicker: readOptionalString(body, "market_ticker"),
    outcomeSide: readOptionalString(body, "outcome_side"),
    bookSide: readOptionalString(body, "book_side"),
    countFp: readOptionalString(body, "count_fp"),
    yesPriceDollars: readOptionalString(body, "yes_price_dollars"),
    noPriceDollars: readOptionalString(body, "no_price_dollars"),
    feeCost: readOptionalString(body, "fee_cost"),
    side: readRequiredString(body, "side"),
    action: readOptionalString(body, "action"),
    isTaker: readRequiredBoolean(body, "is_taker"),
    createdTime: readRequiredString(body, "created_time"),
    subaccountNumber: readOptionalNumber(body, "subaccount_number"),
    ts: readOptionalNumber(body, "ts")
  };
}

function resolveTickerFilter(ticker?: string, tickers?: readonly string[]): string | readonly string[] | undefined {
  if (ticker && tickers && tickers.length > 0) {
    throw new Error("Specify either ticker or tickers, not both.");
  }
  if (tickers && tickers.length > 0) {
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
  const value = body[name];
  return typeof value === "string" ? value : undefined;
}

function readRequiredBoolean(body: Record<string, unknown>, name: string): boolean {
  const value = body[name];
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function readOptionalNumber(body: Record<string, unknown>, name: string): number | undefined {
  const value = body[name];
  return typeof value === "number" ? value : undefined;
}
