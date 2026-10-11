import assert from "node:assert/strict";
import { constants, generateKeyPairSync, verify } from "node:crypto";
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
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
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
  assert.equal(verify("sha256", Buffer.from("1790000000000GET/trade-api/v2/portfolio/fills"), {
    key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST
  }, Buffer.from(signed.signature, "base64")), true);
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
  assert.equal(new Headers(calls[0]?.init?.headers).get("Accept"), "application/json");
});

test("portfolio getFills uses the generated operation and typed parser", async () => {
  const client = new KalshiClient({
    fetch: async (input, init) => {
      assert.equal(String(input), "https://external-api.kalshi.com/trade-api/v2/portfolio/fills?limit=2&ticker=KXA%2CKXB");
      assert.equal(init?.method, "GET");
      return jsonResponse({
        fills: [
          {
            ...validFill(),
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
        ...validFill(),
        trade_id: "trade-1",
        order_id: "order-1",
        ticker: "KXAAA",
        side: "yes",
        is_taker: false,
        created_time: "2026-10-11T12:00:00Z"
      }
    ],
    cursor: ""
  });
  assert.equal(page.fills.length, 1);
  assert.equal(page.cursor, "");
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

function validFill(): Record<string, unknown> {
  return {
    fill_id: "fill-1", exchange_index: 0, trade_id: "trade-1", order_id: "order-1",
    ticker: "KXA", market_ticker: "KXA", outcome_side: "yes", book_side: "bid",
    count_fp: "3.00", yes_price_dollars: "0.4700", no_price_dollars: "0.5300",
    fee_cost: "0.0200", is_taker: true
  };
}

test("fills parser honors official required optional enum and nullable fields", () => {
  const page = parseFillsPage({ fills: [{ ...validFill(), subaccount_number: null }], cursor: "next" });
  assert.equal(page.fills[0]?.side, undefined);
  assert.equal(page.fills[0]?.createdTime, undefined);
  assert.equal(page.fills[0]?.subaccountNumber, null);
  assert.equal(page.fills[0]?.countFp, "3.00");
  for (const name of Object.keys(validFill())) {
    const fill = validFill();
    delete fill[name];
    assert.throws(() => parseFillsPage({ fills: [fill], cursor: "" }), new RegExp(name));
  }
  for (const [name, value] of [["count_fp", 3], ["exchange_index", 0.5], ["outcome_side", "bid"],
    ["book_side", "yes"], ["side", "bid"], ["action", "hold"], ["created_time", 123],
    ["subaccount_number", "0"], ["ts", 1.5], ["is_taker", "true"]]) {
    assert.throws(() => parseFillsPage({ fills: [{ ...validFill(), [name as string]: value }], cursor: "" }));
  }
  for (const cursor of [undefined, null, 123]) assert.throws(() => parseFillsPage({ fills: [], cursor }));
});

test("operation lookup rejects inherited names and missing own path parameters", () => {
  for (const name of ["toString", "constructor", "__proto__", "unknown"]) assert.throws(() => getOperation(name));
  assert.throws(() => buildOperationPath(getOperation("GetMarket"), Object.create({ ticker: "KXA" })));
});

test("actual requests repeat official array query keys while fills keep CSV", async () => {
  const cases = [
    { id: "GetMarketOrderbooks", query: { tickers: ["A", "B"] }, path: {}, suffix: "/markets/orderbooks?tickers=A&tickers=B" },
    { id: "GetLiveDatas", query: { milestone_ids: ["A", "B"] }, path: {}, suffix: "/live_data/batch?milestone_ids=A&milestone_ids=B" },
    { id: "GetStructuredTargets", query: { ids: ["A", "B"] }, path: {}, suffix: "/structured_targets?ids=A&ids=B" },
    { id: "GetEventForecastPercentilesHistory", query: { percentiles: [1, 9999] }, path: { series_ticker: "S", ticker: "T" },
      suffix: "/series/S/events/T/forecast_percentile_history?percentiles=1&percentiles=9999" }
  ];
  for (const item of cases) {
    const client = new KalshiClient({ environment: "demo", fetch: async (url, init) => {
      assert.equal(String(url), `https://demo-api.kalshi.co/trade-api/v2${item.suffix}`);
      assert.equal(init?.method, "GET");
      return jsonResponse({});
    }});
    await client.request(item.id, { authenticated: false, query: item.query, pathParameters: item.path });
  }
});

test("mixed-case header overrides produce one correct signed value", async () => {
  const auth = testAuth();
  const client = new KalshiClient({ auth, defaultHeaders: { accept: "text/plain", "kalshi-access-key": "stale" },
    fetch: async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("accept"), "custom/type");
      assert.equal(headers.get("content-type"), "application/custom+json");
      assert.equal(headers.get("kalshi-access-key"), "test-key-id");
      assert.equal(headers.get("kalshi-access-timestamp"), "1790000000000");
      assert.doesNotMatch(headers.get("kalshi-access-signature") ?? "", /stale|,/);
      return jsonResponse({});
    }});
  await client.request("CreateOrderV2", { body: {}, headers: { ACCEPT: "custom/type", "content-type": "application/custom+json",
    "kalshi-access-signature": "stale", "kalshi-access-timestamp": "stale" } });
});

test("HTTP failures retain status headers and raw malformed bodies", async () => {
  for (const status of [400, 429, 502]) {
    const client = new KalshiClient({ fetch: async () => new Response("{broken", {
      status, headers: { "content-type": "application/json", "retry-after": "5" }
    }) });
    await assert.rejects(client.request("GetMarkets", { authenticated: false }), (error) =>
      error instanceof KalshiApiError && error.status === status && error.body === "{broken" && error.headers.get("retry-after") === "5");
  }
  const client = new KalshiClient({ fetch: async () => new Response("{broken", { headers: { "content-type": "application/json" } }) });
  await assert.rejects(client.request("GetMarkets", { authenticated: false }), SyntaxError);
});

test("raw requests preserve empty successes and text responses", async () => {
  for (const [status, text, expected] of [[204, null, undefined], [200, "", undefined], [200, "ok", "ok"]] as const) {
    const client = new KalshiClient({ fetch: async () => new Response(text, { status }) });
    const result = await client.rawRequest("GetExchangeStatus", { authenticated: false });
    assert.equal(result.body, expected);
    assert.equal(result.response.status, status);
  }
});

test("fills query helper and client reject invalid filters before HTTP", async () => {
  const client = new KalshiClient({ auth: testAuth(), fetch: async () => { throw new Error("HTTP must not run"); } });
  for (const query of [{ tickers: [] }, { ticker: "" }, { tickers: [" "] }, { ticker: "A", tickers: ["B"] },
    { tickers: Array.from({ length: 101 }, () => "A") }, { limit: NaN }, { limit: 0 }, { limit: 1001 },
    { subaccount: 1.5 }, { subaccount: 64 }, { exchangeIndex: -1 }, { minTs: Infinity }, { maxTs: 1.5 }]) {
    assert.throws(() => buildPortfolioFillsPath(query));
    await assert.rejects(client.portfolio.getFills(query), (error) => error instanceof Error && error.message !== "HTTP must not run");
  }
});

test("fills pagination forwards opaque cursor without converting fixed-point amounts", async () => {
  let call = 0;
  const client = new KalshiClient({ auth: testAuth(), fetch: async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("cursor"), call === 0 ? null : "opaque+/=?");
    call++;
    return jsonResponse({ fills: [validFill()], cursor: call === 1 ? "opaque+/=?" : "" });
  }});
  const first = await client.portfolio.getFills();
  const second = await client.portfolio.getFills({ cursor: first.cursor });
  assert.equal(second.cursor, "");
  assert.equal(second.fills[0]?.yesPriceDollars, "0.4700");
  assert.equal(call, 2);
});
