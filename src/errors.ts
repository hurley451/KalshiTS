export class KalshiApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: unknown;
  readonly headers: Headers;

  constructor(response: Response, body: unknown) {
    super(`Kalshi API request failed with HTTP ${response.status} ${response.statusText}`.trim());
    this.name = "KalshiApiError";
    this.status = response.status;
    this.statusText = response.statusText;
    this.body = body;
    this.headers = response.headers;
  }
}

export class KalshiOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KalshiOperationError";
  }
}
