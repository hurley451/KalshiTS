# KalshiTS

TypeScript SDK target for [KalshiCore](https://github.com/hurley451/KalshiCore)
conformance.

KalshiTS exposes every official REST operation tracked by KalshiCore through a
generated operation registry and a small idiomatic client. Reviewed endpoint
contracts can add richer typed helpers over time without blocking access to the
full Kalshi REST surface.

## Current Scope

- Generated registry for all KalshiCore official REST operations.
- Environment-aware REST client for production and demo.
- API key request signing with Kalshi RSA-PSS headers.
- Path parameter, query parameter, JSON body, JSON response, and API error handling.
- Typed `portfolio.getFills` helper backed by the generated `GetFills` operation.
- WebSocket envelope parsing used by KalshiCore replay fixtures.
- Scheduled KalshiCore conformance with optional parent issue filing.

## Usage

```ts
import { KalshiClient } from "@hurley451/kalshi-ts";

const client = new KalshiClient({
  environment: "demo",
  auth: {
    apiKeyId: process.env.KALSHI_API_KEY_ID!,
    privateKeyPem: process.env.KALSHI_PRIVATE_KEY_PEM!
  }
});

const markets = await client.request("GetMarkets", {
  query: { limit: 100 }
});

const fills = await client.portfolio.getFills({
  tickers: ["KXAAA", "KXBBB"],
  limit: 100
});
```

To call any generated operation directly, pass the official `operationId` plus
path, query, and body values:

```ts
await client.request("GetMarket", {
  pathParameters: { ticker: "KXTEST-26" }
});
```

Unauthenticated public calls can opt out of signing:

```ts
await client.request("GetExchangeStatus", { authenticated: false });
```

## Generated Operations

```bash
npm run generate:operations -- --kalshicore-root /path/to/KalshiCore
```

The generated registry records the official OpenAPI source URL, version, source
hash, and operation count from KalshiCore.

## Local Conformance

```bash
npm install
npm run generate:operations -- --kalshicore-root /path/to/KalshiCore
npm run build
npm test
npm run conformance -- --kalshicore-root /path/to/KalshiCore --report artifacts/kalshicore-conformance/report.json
```

Scheduled parent issue filing requires a `KALSHICORE_ISSUE_TOKEN` repository
secret with issue access to `hurley451/KalshiCore`.
