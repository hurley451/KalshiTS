# KalshiTS

[![CI](https://github.com/hurley451/KalshiTS/actions/workflows/kalshicore-conformance.yml/badge.svg?branch=main)](https://github.com/hurley451/KalshiTS/actions/workflows/kalshicore-conformance.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![Status: prerelease](https://img.shields.io/badge/status-prerelease-yellow.svg)](https://github.com/hurley451/KalshiTS/releases)
[![GitHub stars](https://img.shields.io/github/stars/hurley451/KalshiTS.svg?style=social)](https://github.com/hurley451/KalshiTS/stargazers)

A TypeScript and JavaScript SDK for the [Kalshi](https://kalshi.com) prediction
market API, built for Node.js 20+ with ESM exports and TypeScript declarations.

This is a community client, not an official Kalshi SDK.
The npm package is `@hurley451/kalshi-ts` and is not yet published. See the
[release status](docs/RELEASES.md).

## Contents

- [Features and coverage](#features)
- [Requirements and installation](#requirements)
- [Quick start](#quick-start)
- [Authentication](#authentication)
- [REST examples](#rest-examples)
- [WebSocket message parsing](#websocket-message-parsing)
- [Error handling](#error-handling)
- [Configuration](#configuration)
- [Operation lookup](#operation-lookup)
- [Running examples](#running-examples)
- [SDK family and support](#sdk-family-and-support)

## Features

- 118 named REST methods across 17 domain facades, with typed inputs and responses.
- 209 schema-derived models and runtime request/response contract validation.
- Promise-based HTTP requests using Node.js fetch, with production and demo environments.
- Automatic RSA-PSS request signing using Node.js crypto.
- Path substitution, query encoding, JSON bodies, and API error details.
- Typed portfolio fills helper with camelCase fields and fixed-point strings.
- WebSocket envelope parsing and shared offline conformance fixtures.
- Custom fetch implementations, request headers, and access to raw HTTP responses.

Generic requests return `unknown` unless the caller supplies a type argument.
That type argument does not validate the response at runtime. Named methods
validate official parameter, request-body, and response schemas. Where the source
omits a response schema, its body remains `unknown` and requires application-level
narrowing. HTTP 204 responses return `undefined`.

### API Coverage

| API family | Selected generated operation IDs | Support |
|------------|----------------------------------|---------|
| Exchange | `getExchangeStatus`, `getExchangeSchedule` | Typed REST |
| Account | `getAccountApiLimits`, `getAccountEndpointCosts` | Typed REST |
| Markets | `getMarkets`, `getMarket`, `getMarketOrderbook`, `getTrades` | Typed REST |
| Events and series | `getEvents`, `getEvent`, `getSeriesList`, `getSeries` | Typed REST |
| Discovery | `getStructuredTargets`, `getMilestones`, `getMultivariateEventCollections` | Typed REST |
| V2 orders | `createOrderV2`, `cancelOrderV2`, `amendOrderV2`, `batchCreateOrdersV2` | Typed REST |
| Order groups | `getOrderGroups`, `createOrderGroup`, `triggerOrderGroup` | Typed REST |
| Portfolio | `getBalance`, `getPositions`, `getSettlements`, `getFills` | Typed REST; camelCase fills helper |
| Subaccounts | `getSubaccountBalances`, `applySubaccountTransfer`, `getSubaccountTransfers` | Typed REST |
| Historical | `getHistoricalCutoff`, `getHistoricalMarkets`, `getFillsHistorical` | Typed REST |
| Incentives and allocation | `getIncentivePrograms`, `getTargetBalanceAllocation` | Typed REST |
| Live data | `getEventLiveData`, `getWeatherIndex`, `getWeatherIndexCalibrations` | Typed REST |
| API keys | `getApiKeys`, `createApiKey`, `deleteApiKey` | Typed REST |
| Communications and FCM | `getCommunicationsID`, `getRFQs`, `getQuotes`, `getFCMOrders` | Typed REST |
| WebSocket | `parseWebSocketMessage` | Parsing only; no transport or subscriptions |

The checked-in OpenAPI snapshot contains 118 REST operations. Named methods and
contract tests cover each operation; this is not live exchange verification. See
[API coverage and gaps](docs/API_COVERAGE.md) and [official API docs](https://docs.kalshi.com).

Automatic retries, rate limiting, a public cancellation/timeout option, WebSocket
connections/reconnect, and browser support are not implemented. Node.js crypto is
required even when a particular request is public.

## Requirements

- Node.js 20 or newer and an ESM consumer (`.mjs` or `"type": "module"`).
- npm for dependency installation and local packaging.
- TypeScript and `@types/node` when compiling TypeScript consumers.
- Kalshi API credentials for private endpoints, separately issued for demo/production.
- A KalshiCore checkout only when regenerating operations or running conformance.

## Installation

Until the first npm release, build and pack a checkout:

```bash
git clone https://github.com/hurley451/KalshiTS.git
cd KalshiTS
npm ci
npm pack
```

From your application directory, install the produced tarball:

```bash
npm install /path/to/KalshiTS/hurley451-kalshi-ts-0.1.0-alpha.1.tgz
```

The tarball contains runtime code, declarations, license, README, and linked
support/coverage documentation. It excludes compiled tests and tooling.
After the initial prerelease is published, installation will be
`npm install @hurley451/kalshi-ts@next`. Check registry availability before using
that command.

## Quick Start

Put this in `quickstart.mjs` in your application and run `node quickstart.mjs`:

```js
import { KalshiClient } from "@hurley451/kalshi-ts";

const client = new KalshiClient({ environment: "demo" });
const status = await client.exchange.getExchangeStatus();
console.log(status);
```

Named public calls work without credentials. The client defaults to production.
Generic `request` calls default to authenticated; pass `authenticated: false`
for unsigned generic calls.

## Authentication

Use a PEM file rather than embedding a private key in source:

```bash
export KALSHI_API_KEY_ID="your-demo-api-key-id"
export KALSHI_PRIVATE_KEY_FILE="/absolute/path/to/demo-private-key.pem"
```

```ts
import { readFileSync } from "node:fs";
import { KalshiClient } from "@hurley451/kalshi-ts";

const apiKeyId = process.env.KALSHI_API_KEY_ID;
const keyFile = process.env.KALSHI_PRIVATE_KEY_FILE;
if (!apiKeyId || !keyFile) throw new Error("Set the API key ID and PEM file path.");

const client = new KalshiClient({
  environment: "demo",
  auth: { apiKeyId, privateKeyPem: readFileSync(keyFile) }
});
const balance = await client.portfolio.getBalance();
console.log(balance);
```

`privateKeyPem` accepts a PEM string, Buffer, or Node.js KeyObject.
RSA-PSS signing uses SHA-256 and a digest-length salt. It signs the timestamp,
uppercase method, and API path without the query string. Keep system time accurate
and use credentials issued for the selected environment. Ed25519 is not supported.

## REST Examples

The following snippets use a `client` constructed above. Generic calls use
official wire names (`snake_case`); the typed fills helper uses camelCase.

### List Markets with Pagination

Named calls infer response types and validate the official schema.

```ts
let cursor: string | undefined;
do {
  const page = await client.markets.getMarkets({
    query: { limit: 100, status: "open", ...(cursor ? { cursor } : {}) }
  });
  for (const market of page.markets) console.log(market.ticker, market.title);
  cursor = page.cursor || undefined;
} while (cursor);
```

There is no automatic paginator. Preserve filters when continuing a cursor.

### Get Market Details and an Order Book

Use a ticker returned by market discovery:

```ts
const ticker = "YOUR-DEMO-MARKET-TICKER";
const market = await client.markets.getMarket({
  pathParameters: { ticker }
});
const book = await client.markets.getMarketOrderbook({
  pathParameters: { ticker },
  query: { depth: 10 }
});
console.log(market, book);
```

The current order-book response uses `orderbook_fp` with `yes_dollars` and
`no_dollars` levels. Fixed-point price and quantity strings should remain
strings, or use an application-selected decimal library for arithmetic.

### Portfolio Fills and Pagination

Use the authenticated client for the typed helper:

```ts
let fillsCursor: string | undefined;
do {
  const page = await client.portfolio.getFills({
    tickers: ["YOUR-MARKET-A", "YOUR-MARKET-B"],
    limit: 100,
    cursor: fillsCursor
  });
  for (const fill of page.fills) {
    console.log(fill.ticker, fill.countFp, fill.yesPriceDollars, fill.feeCost);
  }
  fillsCursor = page.cursor || undefined;
} while (fillsCursor);
```

Use either a single `ticker` or a populated `tickers` list, not both.
Lists accept at most 100 entries and reject blank entries. Optional filters include
`orderId`, `subaccount`, `exchangeIndex`, `minTs`, and `maxTs`.
The helper sends a comma-separated `ticker` query parameter.

The parser checks required fill fields and directional enums. Deprecated `side`
and `action`, `createdTime`, and `ts` are optional; `subaccountNumber` can also be
null. Fixed-point amounts remain strings. Pages require a string `cursor`;
an empty cursor marks the final page. Known numeric filter constraints are
checked before sending the request.

### Balance, Positions, and Historical Data

```ts
console.log(await client.request("GetBalance", { query: { subaccount: 0 } }));
console.log(await client.request("GetPositions", {
  query: { limit: 100, settlement_status: "unsettled" }
}));
console.log(await client.request("GetHistoricalCutoff", { authenticated: false }));
console.log(await client.request("GetHistoricalMarkets", {
  authenticated: false,
  query: { limit: 100 }
}));
```

Historical access is explicit; live requests are not automatically rerouted.

### Events, Series, and Live Data

```ts
console.log(await client.request("GetEvents", {
  authenticated: false, query: { limit: 10 }
}));
console.log(await client.request("GetSeriesList", { authenticated: false }));
console.log(await client.request("GetStructuredTargets", { authenticated: false }));
console.log(await client.request("GetMilestones", {
  authenticated: false, query: { limit: 10 }
}));
console.log(await client.request("GetWeatherIndex", {
  authenticated: false, pathParameters: { city: "miami" }
}));
```

Use operation lookup below to find other operation IDs and required paths.

### Demo Order Creation and Cancellation

This function submits an order when called. Use demo credentials and a currently
tradable demo ticker. It uses a demo client.
Named order methods validate inputs against the checked-in official schema.

```ts
import { randomUUID } from "node:crypto";
import { KalshiClient, type KalshiAuthOptions } from "@hurley451/kalshi-ts";

async function demoOrder(auth: KalshiAuthOptions, ticker: string) {
  const demo = new KalshiClient({ environment: "demo", auth });
  const order = await demo.orders.createOrderV2({
    body: {
      ticker, side: "bid", count: "1.00", price: "0.0100",
      time_in_force: "good_till_canceled",
      self_trade_prevention_type: "taker_at_cross",
      client_order_id: randomUUID(), exchange_index: -1
    }
  });
  if (!order.order_id) throw new Error("Creation returned no order ID.");
  return demo.orders.cancelOrderV2({
    pathParameters: { order_id: order.order_id },
    query: { exchange_index: -1, market_ticker: ticker }
  });
}
```

Cancellation does not undo fills. The read-only example runner below never calls
this function or any mutation.

## WebSocket Message Parsing

Parsing accepts an already-decoded object, not raw JSON text:

```ts
import { parseWebSocketMessage } from "@hurley451/kalshi-ts";

const text = '{"type":"orderbook_delta","sid":1,"seq":2,"msg":{"market_ticker":"DEMO"}}';
const envelope = parseWebSocketMessage(JSON.parse(text));
console.log(envelope.type, envelope.sid, envelope.seq, envelope.msg);
```

A transport must be supplied by the application. The parser does not connect,
subscribe, reconnect, validate channel payload schemas, or maintain an order book.
`OrderBookDeltaMessage` is a TypeScript interface, not a runtime validator.

## Error Handling

```ts
import { KalshiApiError, KalshiContractError, isEndpointError } from "@hurley451/kalshi-ts";

try {
  await client.portfolio.getBalance();
} catch (error) {
  if (error instanceof KalshiApiError) {
    console.error("HTTP status:", error.status);
    if (error.status === 429) console.error("Retry-After:", error.headers.get("retry-after"));
    // Inspect error.body locally; redact account details before logging it.
    if (isEndpointError(error, "GetBalance")) {
      console.error("Declared endpoint failure:", error.contract.status);
    }
  } else if (error instanceof KalshiContractError) {
    console.error("Contract violation:", error.operationId, error.part);
  } else {
    throw error; // Key parsing, helper validation, JSON, or fetch failure.
  }
}
```

Retry policy belongs to the application. A failed mutation must not be blindly
replayed because the exchange may already have accepted it.

## Configuration

| Option | Default | Behavior |
|--------|---------|----------|
| `environment` | `"production"` | `"demo"`, `"production"`, or a custom environment object |
| `auth` | None | API key ID and private key; required for authenticated calls |
| `fetch` | Global fetch | Inject a compatible HTTP implementation, including test doubles |
| `defaultHeaders` | Empty | Applied to all requests |
| `auth.timestampProvider` | `Date.now` | Supplies signing timestamp in milliseconds |
| Request `authenticated` | Inferred for named calls | Generic requests default to true |
| Request `headers` | Empty | Overrides default headers; signing supplies authentication headers |
| Request `pathParameters`, `query`, `body` | Empty/absent | Path values, query values, and JSON body |

```ts
const { body, response } = await client.rawRequest("GetExchangeStatus", {
  authenticated: false, headers: { "Accept-Language": "en" }
});
console.log(response.status, body);
```

A custom environment object supplies `name`, `restBaseUrl`, and `websocketUrl`.
Only `restBaseUrl` is used by this HTTP client. There is no direct request
`signal` or timeout option; implement those policies in an injected fetch
wrapper if needed.

## Operation Lookup

```ts
import { operations, getOperation } from "@hurley451/kalshi-ts";

console.table(operations.filter(operation => operation.path.startsWith("/portfolio")));
console.log(getOperation("GetMarket"));
```

See [contributing](CONTRIBUTING.md) for development and test commands.

## Project Structure

```text
src/
  auth.ts             RSA-PSS signing
  client.ts           Typed HTTP execution and fills convenience method
  contracts.ts        Runtime request/response validation
  environment.ts      Production/demo URLs
  errors.ts           API and operation errors
  generated/          Named endpoints, models, schemas and coverage
  operation.ts        Path substitution and query serialization
  portfolio.ts        Fills types, filters, and parsing
  websocket.ts        Envelope parsing
examples/read-only.ts Read-only demo examples
scripts/              Inventory generation and conformance adapter
test/                 SDK tests
docs/                 API documentation
```

## Running Examples

From a repository checkout:

```bash
npm ci
npm run build
node dist/examples/read-only.js status
node dist/examples/read-only.js markets
node dist/examples/read-only.js orderbook YOUR-DEMO-MARKET-TICKER
# Requires demo API key ID and private-key file environment variables:
node dist/examples/read-only.js fills
```

Every scenario uses demo and performs read-only requests. Public scenarios need
no credentials. See [example source](https://github.com/hurley451/KalshiTS/blob/main/examples/read-only.ts).

## SDK Family and Support

| Project | Role |
|---------|------|
| [KalshiCore](https://github.com/hurley451/KalshiCore) | Shared contracts, fixtures, and conformance framework |
| [KalshiSharp](https://github.com/hurley451/KalshiSharp) | C# / .NET SDK |
| [KalshiTS](https://github.com/hurley451/KalshiTS) | TypeScript / JavaScript SDK for Node.js |
| [kalshi-rs](https://github.com/hurley451/kalshi-rs) | Rust SDK, package name `kalshi-client` |

Read [contributing](CONTRIBUTING.md), ask a
[usage question](https://github.com/hurley451/KalshiTS/issues/new?template=question.yml),
or open a [discussion](https://github.com/hurley451/KalshiTS/discussions).
Report SDK behavior here and shared contract/fixture gaps in KalshiCore.

## License

[MIT](LICENSE).
