# KalshiTS

TypeScript SDK target for [KalshiCore](https://github.com/hurley451/KalshiCore)
conformance.

This repository is intentionally small at the start. It proves the first
cross-language KalshiCore fixture suite in an idiomatic TypeScript package
before expanding into a broader SDK surface.

## Current Scope

- API key signing preimage construction.
- `GET /portfolio/fills` query serialization.
- `GET /portfolio/fills` response parsing.
- WebSocket orderbook replay parsing.
- Scheduled KalshiCore conformance with optional parent issue filing.

## Local Conformance

```bash
npm install
npm run build
npm run conformance -- --kalshicore-root /path/to/KalshiCore --report artifacts/kalshicore-conformance/report.json
```

Scheduled parent issue filing requires a `KALSHICORE_ISSUE_TOKEN` repository
secret with issue access to `hurley451/KalshiCore`.
