# KalshiTS

[![CI](https://github.com/hurley451/KalshiTS/actions/workflows/kalshicore-conformance.yml/badge.svg)](https://github.com/hurley451/KalshiTS/actions/workflows/kalshicore-conformance.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![Status: prerelease](https://img.shields.io/badge/status-prerelease-yellow.svg)](https://github.com/hurley451/KalshiTS/releases)
[![GitHub stars](https://img.shields.io/github/stars/hurley451/KalshiTS.svg?style=social)](https://github.com/hurley451/KalshiTS/stargazers)

A TypeScript and JavaScript SDK for the [Kalshi](https://kalshi.com) prediction
market API, built for Node.js 20+ with ESM exports and TypeScript declarations.

KalshiTS is a community SDK built from [KalshiCore](https://github.com/hurley451/KalshiCore)
contracts and conformance fixtures, not an official Kalshi SDK.

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

See [API coverage](docs/API_COVERAGE.md) for the distinction between operation
inventory, typed helpers, and tested contracts. WebSocket connections, automatic
retries, and rate limiting are not implemented. Authentication uses Node.js crypto;
browser bundling is not supported.

## Installation

The npm package `@hurley451/kalshi-ts` has not yet been published. Build and pack
a checkout, then install the resulting tarball in your application:

```bash
git clone https://github.com/hurley451/KalshiTS.git
cd KalshiTS
npm ci
npm pack
# From your application directory:
npm install /path/to/KalshiTS/hurley451-kalshi-ts-0.1.0.tgz
```

After the first npm release, install with `npm install @hurley451/kalshi-ts`.

## Quick Start

Public exchange status requires no credentials:

```js
import { KalshiClient } from "@hurley451/kalshi-ts";

const client = new KalshiClient({ environment: "demo" });
const status = await client.request("GetExchangeStatus", { authenticated: false });
console.log(status);
```

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

## SDK Family

| Project | Role |
|---------|------|
| [KalshiCore](https://github.com/hurley451/KalshiCore) | Shared contracts, fixtures, and conformance framework |
| [KalshiSharp](https://github.com/hurley451/KalshiSharp) | C# / .NET SDK |
| [KalshiTS](https://github.com/hurley451/KalshiTS) | TypeScript / JavaScript SDK for Node.js |
| [kalshi-rs](https://github.com/hurley451/kalshi-rs) | Rust SDK, package name `kalshi-client` |

## Contributing and Support

Read [contributing](CONTRIBUTING.md), ask a [usage question](https://github.com/hurley451/KalshiTS/issues/new?template=question.yml),
or open a [discussion](https://github.com/hurley451/KalshiTS/discussions).
See [visibility tracking](docs/VISIBILITY.md) for discovery metrics and
[official Kalshi API documentation](https://docs.kalshi.com) for upstream contracts.

## License

[MIT](LICENSE).
