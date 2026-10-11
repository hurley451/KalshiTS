# KalshiTS API Coverage

This SDK renders KalshiCore's operation inventory into TypeScript / JavaScript. Its checked-in
OpenAPI snapshot contains 118 REST operations. This is a snapshot count, not a claim
of complete live API compatibility.

## Support Levels

| Surface | Current support |
|---------|-----------------|
| REST inventory | Generated operation IDs, HTTP methods, paths, summaries, and tags; no parameter/body schemas |
| REST execution | Generic operation-ID requests with path/query/body values |
| Authentication | RSA-PSS signing, API-key headers, canonical signing paths |
| Environments | Production and demo |
| Portfolio fills | Query helper and response parsing |
| WebSocket | Envelope parsing and offline replay; no connection/subscription client |
| Conformance | Four registered offline fixtures |

`portfolio.getFills` returns typed fills; other operation responses default to `unknown`.
A generic TypeScript type argument is a caller assertion, not runtime schema validation.

## Validated Contracts

The target manifest registers these fixtures:

- `auth.signing.rest-get-portfolio-fills`
- `rest.request.portfolio-fills-query`
- `rest.response.portfolio-fills-page`
- `websocket.replay.orderbook-delta`

See the [parent framework](https://github.com/hurley451/KalshiCore) for source
provenance, fixture contents, and target registration. Passing these fixtures does
not validate all 118 endpoint request/response contracts or live exchange behavior.

## Remaining Gaps

- Dedicated typed models and contract tests for most REST endpoints.
- WebSocket transport, subscriptions, reconnect, and order-book state management.
- Automatic retries, rate limiting, and cancellation configuration.
- Credentialed integration tests and independent live API validation.
- Public registry release and published-package consumer verification.

Track SDK implementation gaps in this repository. File shared contract or fixture
gaps in KalshiCore with evidence and a link to the affected SDK issue.
