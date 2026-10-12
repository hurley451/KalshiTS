# KalshiTS API Coverage

The checked-in official OpenAPI snapshot contains 118 REST operations and 209
component schemas. Every operation has a named method, typed input/output/error
models and runtime contract validation. This does not prove live compatibility
with later API changes.

## Support Levels

| Surface | Current support |
|---------|-----------------|
| REST methods | 118 named root methods and 17 domain facades |
| Inputs | Typed path/query/header/cookie parameters and JSON bodies |
| Models | Source enums, optionality, nullability, unions and fixed-point strings |
| Responses | Declared success/error schemas; HTTP 204 returns undefined |
| Unspecified bodies | Unknown, not assumed empty; failure metadata retained |
| Authentication | RSA-PSS signing, API-key headers, canonical signing paths |
| Environments | Production and demo |
| Transport | Configurable fetch, total deadlines, cancellation and local rate limits |
| Retries | Opt-in, bounded GET-only retries; mutations never replay automatically |
| Portfolio fills | Query helper and response parsing |
| WebSocket | Envelope parsing and offline replay; no connection/subscription client |
| Conformance | Four registered offline fixtures |

Named methods infer response types and validate the declared schema. The legacy
`portfolio.getFills` helper returns camelCase fills; `portfolio.getFillsRaw` returns
the official wire shape. Generic `request` type arguments remain caller assertions.

The [endpoint matrix](../src/generated/coverage.json) lists methods, parameters,
bodies and status-specific responses. The
[schema matrix](../src/generated/schema-coverage.json) records constraints.

Tests exercise every named operation with schema-derived fixtures, invalid inputs,
declared response statuses and invalid declared payloads. Compiler assertions and
installed tarball consumers check declarations and facades. Source-linked
regressions cover nullable enums and every unspecified response body. These are
offline checks using injected HTTP transports, not authenticated exchange traffic.

## Offline Fixture Checks

The target manifest registers these fixtures:

- `auth.signing.rest-get-portfolio-fills`
- `rest.request.portfolio-fills-query`
- `rest.response.portfolio-fills-page`
- `websocket.replay.orderbook-delta`

See the [parent framework](https://github.com/hurley451/KalshiCore) for fixture
contents. These four fixtures supplement, rather than replace, endpoint tests.

## Remaining Gaps

- Automatic pagination helpers.
- WebSocket transport, subscriptions, reconnect, and order-book state management.
- Credentialed integration tests and independent live API validation.
- Public registry release and published-package consumer verification.

Track SDK implementation gaps in this repository. File shared contract or fixture
gaps in KalshiCore with evidence and a link to the affected SDK issue.

Implementation tracking:

- [Typed REST helper expansion](https://github.com/hurley451/KalshiTS/issues/6).
- [WebSocket transport and recovery](https://github.com/hurley451/KalshiTS/issues/7).
- [Cancellation and transport resilience](https://github.com/hurley451/KalshiTS/issues/8).
