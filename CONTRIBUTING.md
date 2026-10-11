# Contributing to KalshiTS

Focused fixes, API coverage, examples, and documentation improvements are welcome.
Open an issue before a substantial change and describe the endpoint or behavior.

## Development

Use a current checkout of [KalshiCore](https://github.com/hurley451/KalshiCore)
for shared contracts and offline fixtures.

```bash
npm ci
npm test
npm run conformance -- --kalshicore-root /path/to/KalshiCore --report artifacts/kalshicore-conformance/report.json
```

Include the commands and results in your pull request. Keep credentials out of
source, examples, logs, and issue reports.

## SDK and Framework Boundaries

TypeScript / JavaScript implementation, packaging, runtime behavior, and user documentation
belong here. Shared API contracts and fixtures belong in KalshiCore. Link official
Kalshi documentation when changing API behavior, and include a focused regression
test when behavior changes.

Use [questions](https://github.com/hurley451/KalshiTS/issues/new?template=question.yml)
or [discussions](https://github.com/hurley451/KalshiTS/discussions) for usage help.
