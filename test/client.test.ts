import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  buildOperationPath,
  buildPortfolioFillsPath,
  buildSigningPreimage,
  buildTradeApiPath,
  getOperation,
  KalshiApiError,
  KalshiClient,
  officialOperationSource,
  operations,
  parseFillsPage,
  signKalshiRequest
} from "../src/index.js";

test("generated registry covers the current KalshiCore official REST inventory", () => {
  assert.equal(officialOperationSource.operationCount, 118);
  assert.equal(operations.length, officialOperationSource.operationCount);
  assert.equal(getOperation("GetFills").path, "/portfolio/fills");
});

test("builds operation paths with path parameters and comma-delimited array query values", () => {
  const operation = getOperation("GetMarket");
  assert.equal(
    buildOperationPath(operation, { ticker: "KXTEST-26" }, { tags: ["macro", "rates"], limit: 10 }),
    "/markets/KXTEST-26?tags=macro%2Crates&limit=10"
  );
});

test("builds trade API signing paths without duplicating the version prefix", () => {
  assert.equal(buildTradeApiPath("/portfolio/fills?limit=2"), "/trade-api/v2/portfolio/fills?limit=2");
  assert.equal(
    buildTradeApiPath("/trade-api/v2/portfolio/fills?limit=2"),
    "/trade-api/v2/portfolio/fills?limit=2"
  );
  assert.equal(
    buildSigningPreimage("1790000000000", "get", "/trade-api/v2/portfolio/fills?limit=2"),
    "1790000000000GET/trade-api/v2/portfolio/fills"
  );
});

test("signs authenticated Kalshi request headers with RSA-PSS", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signed = signKalshiRequest(
    {
      apiKeyId: "test-key-id",
      privateKeyPem: privateKey,
      timestampProvider: () => "1790000000000"
    },
    "GET",
    "/trade-api/v2/portfolio/fills?limit=2"
  );

  assert.equal(signed.headers["KALSHI-ACCESS-KEY"], "test-key-id");
  assert.equal(signed.headers["KALSHI-ACCESS-TIMESTAMP"], "1790000000000");
  assert.match(signed.headers["KALSHI-ACCESS-SIGNATURE"], /^[A-Za-z0-9+/]+=*$/);
});

test("executes a generated operation through the HTTP client", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = new KalshiClient({
    environment: "demo",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ market: { ticker: "KXTEST-26" } });
    }
  });

  const body = await client.request("GetMarket", {
    authenticated: false,
    pathParameters: { ticker: "KXTEST-26" },
    query: { nested: true }
  });

  assert.deepEqual(body, { market: { ticker: "KXTEST-26" } });
  assert.equal(calls[0]?.url, "https://demo-api.kalshi.co/trade-api/v2/markets/KXTEST-26?nested=true");
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal((calls[0]?.init?.headers as Record<string, string>).Accept, "application/json");
});

test("portfolio getFills uses the generated operation and typed parser", async () => {
  const client = new KalshiClient({
    fetch: async (input, init) => {
      assert.equal(String(input), "https://external-api.kalshi.com/trade-api/v2/portfolio/fills?limit=2&ticker=KXA%2CKXB");
      assert.equal(init?.method, "GET");
      return jsonResponse({
        fills: [
          {
            fill_id: "fill-1",
            trade_id: "trade-1",
            order_id: "order-1",
            ticker: "KXA",
            side: "yes",
            is_taker: true,
            created_time: "2026-10-11T12:00:00Z"
          }
        ],
        cursor: ""
      });
    },
    auth: testAuth()
  });

  const page = await client.portfolio.getFills({ tickers: ["KXA", "KXB"], limit: 2 });
  assert.equal(page.fills[0]?.fillId, "fill-1");
  assert.equal(page.cursor, "");
});

test("throws KalshiApiError for non-success responses", async () => {
  const client = new KalshiClient({
    fetch: async () => jsonResponse({ error: "bad request" }, { status: 400, statusText: "Bad Request" })
  });

  await assert.rejects(
    () => client.request("GetMarkets", { authenticated: false }),
    (error) => error instanceof KalshiApiError && error.status === 400
  );
});

test("keeps existing fills helpers compatible with KalshiCore fixtures", () => {
  assert.equal(
    buildPortfolioFillsPath({ tickers: ["KXAAA", "KXBBB"], limit: 100, cursor: "abc" }),
    "/trade-api/v2/portfolio/fills?limit=100&cursor=abc&ticker=KXAAA%2CKXBBB"
  );
  const page = parseFillsPage({
    fills: [
      {
        trade_id: "trade-1",
        order_id: "order-1",
        ticker: "KXAAA",
        side: "yes",
        is_taker: false,
        created_time: "2026-10-11T12:00:00Z"
      }
    ],
    cursor: null
  });
  assert.equal(page.fills.length, 1);
  assert.equal(page.cursor, null);
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const responseInit: ResponseInit = {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(init.headers).entries())
    }
  };
  if (init.statusText !== undefined) {
    responseInit.statusText = init.statusText;
  }
  return new Response(JSON.stringify(body), {
    ...responseInit
  });
}

function testAuth() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    apiKeyId: "test-key-id",
    privateKeyPem: privateKey,
    timestampProvider: () => "1790000000000"
  };
}
