export interface EndpointOptions {
  headers?: Record<string,string>;
  authenticated?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}
