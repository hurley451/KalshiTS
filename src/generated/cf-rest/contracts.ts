// Generated from reviewed manual Core contracts; not OAS operations.
export const cfContracts = {
  "cfbenchmarks.values": {
    "$schema": "../schemas/endpoint-contract.schema.json",
    "id": "cfbenchmarks.values",
    "name": "cfbenchmarks.values",
    "status": "ready",
    "description": "Manual helper over one documented passthrough; not an enumerated provider API. Path/query validation is an approved SDK input convention.",
    "method": "GET",
    "path": "/trade-api/v2/cfbenchmarks/values",
    "auth": "api-key",
    "rateCost": {
      "bucket": "Read",
      "tokens": 50
    },
    "request": {
      "passthrough": {
        "prefix": "/trade-api/v2/cfbenchmarks/",
        "providerPath": "values",
        "query": {
          "representation": "ordered-string-pairs",
          "open": true,
          "ignoredKeys": [
            "includeVerification"
          ],
          "preserve": [
            "duplicates",
            "order",
            "decoded-values"
          ]
        },
        "signingPath": "final-encoded-pathname-without-query"
      }
    },
    "responses": [
      {
        "status": 200,
        "description": "Open envelope containing unknown upstream JSON.",
        "bodySchema": {
          "type": "object",
          "required": [
            "data"
          ],
          "properties": {
            "data": {}
          },
          "additionalProperties": true
        }
      },
      {
        "status": 400,
        "description": "Documented upstream condition mapping; error body shape unspecified.",
        "bodySchema": {}
      },
      {
        "status": 404,
        "description": "Documented upstream condition mapping; error body shape unspecified.",
        "bodySchema": {}
      },
      {
        "status": 429,
        "description": "Documented upstream condition mapping; error body shape unspecified.",
        "bodySchema": {}
      },
      {
        "status": 503,
        "description": "Documented upstream condition mapping; error body shape unspecified.",
        "bodySchema": {}
      }
    ],
    "fixtures": [
      "../../fixtures/cfbenchmarks/rest-cases.json"
    ],
    "source": {
      "provenance": "official-confirmed",
      "kind": "kalshi-docs",
      "url": "https://docs.kalshi.com/cfbenchmarks/rest-passthrough",
      "observedAt": "2026-10-12T12:13:36.758Z",
      "sourceId": "cfbenchmarks-rest-manual",
      "manualEntryId": "cfbenchmarks.values"
    }
  },
  "cfbenchmarks.history-values": {
    "$schema": "../schemas/endpoint-contract.schema.json",
    "id": "cfbenchmarks.history-values",
    "name": "cfbenchmarks.history-values",
    "status": "ready",
    "description": "Manual helper over one documented passthrough; not an enumerated provider API. Path/query validation is an approved SDK input convention.",
    "method": "GET",
    "path": "/trade-api/v2/cfbenchmarks/history/values",
    "auth": "api-key",
    "rateCost": {
      "bucket": "Read",
      "tokens": 50
    },
    "request": {
      "passthrough": {
        "prefix": "/trade-api/v2/cfbenchmarks/",
        "providerPath": "history/values",
        "query": {
          "representation": "ordered-string-pairs",
          "open": true,
          "ignoredKeys": [
            "includeVerification"
          ],
          "preserve": [
            "duplicates",
            "order",
            "decoded-values"
          ]
        },
        "signingPath": "final-encoded-pathname-without-query"
      }
    },
    "responses": [
      {
        "status": 200,
        "description": "Open envelope containing unknown upstream JSON.",
        "bodySchema": {
          "type": "object",
          "required": [
            "data"
          ],
          "properties": {
            "data": {}
          },
          "additionalProperties": true
        }
      },
      {
        "status": 400,
        "description": "Documented upstream condition mapping; error body shape unspecified.",
        "bodySchema": {}
      },
      {
        "status": 404,
        "description": "Documented upstream condition mapping; error body shape unspecified.",
        "bodySchema": {}
      },
      {
        "status": 429,
        "description": "Documented upstream condition mapping; error body shape unspecified.",
        "bodySchema": {}
      },
      {
        "status": 503,
        "description": "Documented upstream condition mapping; error body shape unspecified.",
        "bodySchema": {}
      }
    ],
    "fixtures": [
      "../../fixtures/cfbenchmarks/rest-cases.json"
    ],
    "source": {
      "provenance": "official-confirmed",
      "kind": "kalshi-docs",
      "url": "https://docs.kalshi.com/cfbenchmarks/rest-passthrough",
      "observedAt": "2026-10-12T12:13:36.758Z",
      "sourceId": "cfbenchmarks-rest-manual",
      "manualEntryId": "cfbenchmarks.history-values"
    }
  },
  "cfbenchmarks.passthrough": {
    "$schema": "../schemas/endpoint-contract.schema.json",
    "id": "cfbenchmarks.passthrough",
    "name": "cfbenchmarks.passthrough",
    "status": "ready",
    "description": "Manual helper over one documented passthrough; not an enumerated provider API. Path/query validation is an approved SDK input convention.",
    "method": "GET",
    "path": "/trade-api/v2/cfbenchmarks/{providerPath}",
    "auth": "api-key",
    "rateCost": {
      "bucket": "Read",
      "tokens": 50
    },
    "request": {
      "passthrough": {
        "prefix": "/trade-api/v2/cfbenchmarks/",
        "providerPath": "decoded-relative-segments",
        "query": {
          "representation": "ordered-string-pairs",
          "open": true,
          "ignoredKeys": [
            "includeVerification"
          ],
          "preserve": [
            "duplicates",
            "order",
            "decoded-values"
          ]
        },
        "signingPath": "final-encoded-pathname-without-query"
      }
    },
    "responses": [
      {
        "status": 200,
        "description": "Open envelope containing unknown upstream JSON.",
        "bodySchema": {
          "type": "object",
          "required": [
            "data"
          ],
          "properties": {
            "data": {}
          },
          "additionalProperties": true
        }
      },
      {
        "status": 400,
        "description": "Documented upstream condition mapping; error body shape unspecified.",
        "bodySchema": {}
      },
      {
        "status": 404,
        "description": "Documented upstream condition mapping; error body shape unspecified.",
        "bodySchema": {}
      },
      {
        "status": 429,
        "description": "Documented upstream condition mapping; error body shape unspecified.",
        "bodySchema": {}
      },
      {
        "status": 503,
        "description": "Documented upstream condition mapping; error body shape unspecified.",
        "bodySchema": {}
      }
    ],
    "fixtures": [
      "../../fixtures/cfbenchmarks/rest-cases.json"
    ],
    "source": {
      "provenance": "official-confirmed",
      "kind": "kalshi-docs",
      "url": "https://docs.kalshi.com/cfbenchmarks/rest-passthrough",
      "observedAt": "2026-10-12T12:13:36.758Z",
      "sourceId": "cfbenchmarks-rest-manual",
      "manualEntryId": "cfbenchmarks.passthrough"
    }
  }
} as const;
