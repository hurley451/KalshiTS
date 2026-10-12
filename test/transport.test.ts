import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import test from "node:test";
import { KalshiClient, KalshiApiError, KalshiAbortError, KalshiTimeoutError, KalshiTransportError, KalshiInvalidResponseError, KalshiResponseReadError, isEndpointError } from "../src/index.js";
import { normalizeRetry, retryDelay } from "../src/transport.js";
import { operationContracts } from "../src/generated/contracts.js";
import type { TypedOperationId } from "../src/index.js";

const statusBody = {exchange_active: true, trading_active: true};
const retry = {maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0};

test("transport policies reject invalid limits before network activity", () => {
  for (const timeoutMs of [-1, NaN, Infinity, 2147483648]) assert.throws(() => new KalshiClient({timeoutMs}), RangeError);
  for (const policy of [{maxAttempts: 0}, {maxAttempts: 7}, {maxAttempts: 1.5}, {baseDelayMs: -1}, {maxDelayMs: Infinity}, {baseDelayMs: 10, maxDelayMs: 1}]) assert.throws(() => new KalshiClient({retry: policy}), RangeError);
  for (const rateLimit of [{capacity: 0, refillPerSecond: 1}, {capacity: 1, refillPerSecond: 0}, {capacity: Infinity, refillPerSecond: 1}]) assert.throws(() => new KalshiClient({rateLimit}), RangeError);
});

test("pre-cancellation avoids HTTP and suppresses caller abort reasons", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort("SECRET_CALLER_REASON");
  const client = new KalshiClient({fetch: async () => {calls++; return Response.json(statusBody);}});
  await assert.rejects(client.getExchangeStatus({}, {signal: controller.signal}), error => error instanceof KalshiAbortError && !String(error).includes("SECRET"));
  assert.equal(calls, 0);
  const immediate = new AbortController();
  const request = assert.rejects(client.getExchangeStatus({}, {signal: immediate.signal}), KalshiAbortError);
  immediate.abort();
  await request;
  assert.equal(calls, 0);
});

test("client inspection does not expose stored credentials or default headers", () => {
  const secret = "SECRET_PRIVATE_MATERIAL";
  const client = new KalshiClient({auth: {apiKeyId: secret, privateKeyPem: secret}, defaultHeaders: {authorization: secret}});
  for (const text of [inspect(client, {depth: 10, showHidden: true}), JSON.stringify(client)]) assert.ok(!text.includes(secret));
});

test("total deadline bounds even an injected fetch that ignores its signal", async () => {
  let captured: AbortSignal | null | undefined;
  const client = new KalshiClient({timeoutMs: 20, fetch: (_url, init) => {
    captured = init?.signal;
    return new Promise(() => {});
  }});
  await assert.rejects(client.getExchangeStatus(), KalshiTimeoutError);
  assert.equal(captured?.aborted, true);
});

test("fake time proves the exact total-deadline boundary", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  let started!: () => void;
  const dispatched = new Promise<void>(resolve => {started = resolve;});
  let signal: AbortSignal | null | undefined;
  const client = new KalshiClient({timeoutMs: 50, fetch: (_url, init) => {
    signal = init?.signal;
    started();
    return new Promise(() => {});
  }});
  const failure = assert.rejects(client.getExchangeStatus(), KalshiTimeoutError);
  await dispatched;
  t.mock.timers.tick(49);
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(1);
  await failure;
  assert.equal(signal?.aborted, true);
});

test("deadline and caller cancellation include response-body consumption", async () => {
  for (const cancel of [false, true]) {
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({start(controller) {streamController = controller;}});
    const abort = new AbortController();
    const client = new KalshiClient({timeoutMs: 25, fetch: async () => new Response(body, {headers: {"content-type": "application/json"}})});
    const timer = cancel ? setTimeout(() => abort.abort(), 5) : undefined;
    try {
      await assert.rejects(client.getExchangeStatus({}, {signal: abort.signal}), cancel ? KalshiAbortError : KalshiTimeoutError);
    } finally { clearTimeout(timer); streamController!.close(); }
  }
});

test("safe GET retries are bounded and preserve terminal HTTP metadata", async () => {
  let calls = 0;
  const client = new KalshiClient({retry, fetch: async () => {
    calls++;
    return Response.json({detail: "busy"}, {status: 503, headers: {"retry-after": "0"}});
  }});
  await assert.rejects(client.getExchangeStatus(), error => error instanceof KalshiInvalidResponseError && error.status === 503 && error.headers.get("retry-after") === "0" && !isEndpointError(error, "GetExchangeStatus"));
  assert.equal(calls, 3);
  let deniedCalls = 0;
  const denied = new KalshiClient({retry, fetch: async () => {deniedCalls++; return Response.json({detail: "denied"}, {status: 401});}});
  await assert.rejects(denied.getExchangeStatus());
  assert.equal(deniedCalls, 1);
});

test("GET network retries sanitize failure details and no retries occur by default", async () => {
  let calls = 0;
  const client = new KalshiClient({retry, fetch: async () => {
    if (++calls < 3) throw new TypeError("SECRET_NETWORK_DETAIL");
    return Response.json(statusBody);
  }});
  assert.deepEqual(await client.getExchangeStatus(), statusBody);
  assert.equal(calls, 3);
  let failures = 0;
  const blocked = new KalshiClient({fetch: async () => {failures++; throw new TypeError("SECRET_NETWORK_DETAIL");}});
  await assert.rejects(blocked.getExchangeStatus(), error => error instanceof KalshiTransportError && !String(error.stack).includes("SECRET"));
  assert.equal(failures, 1);
});

test("every mutation remains single-attempt even when retries are configured", async () => {
  const fixtures = JSON.parse(readFileSync("test/typed-fixtures.json", "utf8")).fixtures as {operationId: TypedOperationId; methodName: string; input: unknown}[];
  let checked = 0;
  for (const fixture of fixtures) {
    if (operationContracts[fixture.operationId]!.method === "GET") continue;
    let calls = 0;
    const client = new KalshiClient({retry, fetch: async () => {calls++; return Response.json({detail: "busy"}, {status: 503});}});
    const method = (client as unknown as Record<string, (input: unknown, options: unknown) => Promise<unknown>>)[fixture.methodName]!;
    await assert.rejects(method.call(client, fixture.input, {authenticated: false}));
    assert.equal(calls, 1, fixture.operationId);
    checked++;
  }
  assert.ok(checked > 20);
});

test("retry backoff is bounded by the total deadline and cancellation", async () => {
  for (const cancel of [false, true]) {
    let calls = 0;
    const controller = new AbortController();
    const client = new KalshiClient({timeoutMs: 30, retry: {maxAttempts: 3}, fetch: async () => {
      calls++;
      return Response.json({}, {status: 429, headers: {"retry-after": "0.25"}});
    }});
    const timer = cancel ? setTimeout(() => controller.abort(), 5) : undefined;
    try { await assert.rejects(client.getExchangeStatus({}, {signal: controller.signal}), cancel ? KalshiAbortError : KalshiTimeoutError); }
    finally { clearTimeout(timer); }
    assert.equal(calls, 1);
  }
  const policy = normalizeRetry({baseDelayMs: 5, maxDelayMs: 10});
  assert.equal(retryDelay(policy, 1, "9000"), undefined);
  assert.equal(retryDelay(policy, 1, new Date(Date.now() + 9000).toUTCString()), undefined);
  assert.equal(retryDelay(policy, 1, "invalid"), 5);
  let calls = 0;
  const tooLong = new KalshiClient({retry: {maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 10}, fetch: async () => {
    calls++;
    return Response.json({}, {status: 429, headers: {"retry-after": "60"}});
  }});
  await assert.rejects(tooLong.getExchangeStatus(), error => error instanceof KalshiApiError && error.headers.get("retry-after") === "60");
  assert.equal(calls, 1);
});

test("rate queue preserves ordering while canceled work consumes no tokens", async () => {
  const order: string[] = [];
  const controller = new AbortController();
  const client = new KalshiClient({rateLimit: {capacity: 1, refillPerSecond: 50}, fetch: async (_url, init) => {
    order.push(new Headers(init?.headers).get("request-name")!);
    return Response.json(statusBody);
  }});
  await client.getExchangeStatus({}, {headers: {"request-name": "first"}});
  const canceled = assert.rejects(client.getExchangeStatus({}, {signal: controller.signal, headers: {"request-name": "canceled"}}), KalshiAbortError);
  const second = client.getExchangeStatus({}, {headers: {"request-name": "second"}});
  const third = client.getExchangeStatus({}, {headers: {"request-name": "third"}});
  controller.abort();
  await Promise.all([canceled, second, third]);
  assert.deepEqual(order, ["first", "second", "third"]);
});

test("rate waits share the total deadline and charge every retry", async () => {
  const costs: string[] = [];
  let calls = 0;
  const client = new KalshiClient({timeoutMs: 30, retry, rateLimit: {capacity: 1, refillPerSecond: 0.1, cost: id => {costs.push(id); return 1;}}, fetch: async () => {
    calls++;
    return Response.json({}, {status: 503});
  }});
  await assert.rejects(client.getExchangeStatus(), KalshiTimeoutError);
  assert.equal(calls, 1);
  assert.deepEqual(costs, ["GetExchangeStatus", "GetExchangeStatus"]);
  const invalid = new KalshiClient({rateLimit: {capacity: 1, refillPerSecond: 1, cost: () => 2}});
  await assert.rejects(invalid.getExchangeStatus(), RangeError);
});

test("body stream failures retain Retry-After and never retry early", async () => {
  let calls = 0;
  const client = new KalshiClient({retry: {maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 10}, fetch: async () => {
    calls++;
    const body = new ReadableStream({start(controller) {controller.error(new Error("SECRET_STREAM_FAILURE"));}});
    return new Response(body, {status: 429, headers: {"retry-after": "60"}});
  }});
  await assert.rejects(client.getExchangeStatus(), error => error instanceof KalshiResponseReadError && error.status === 429 && error.headers.get("retry-after") === "60" && !String(error.stack).includes("SECRET"));
  assert.equal(calls, 1);
});

test("numeric overflow cannot shorten server retry delays or rate waits", async () => {
  assert.equal(retryDelay(normalizeRetry(), 1, "9".repeat(400)), undefined);
  const warnings: Error[] = [];
  const collect = (warning: Error) => {if (warning.name === "TimeoutOverflowWarning") warnings.push(warning);};
  process.on("warning", collect);
  try {
    let calls = 0;
    const client = new KalshiClient({timeoutMs: 20, rateLimit: {capacity: 1, refillPerSecond: Number.MIN_VALUE}, fetch: async () => {calls++; return Response.json(statusBody);}});
    await client.getExchangeStatus();
    await assert.rejects(client.getExchangeStatus(), KalshiTimeoutError);
    assert.equal(calls, 1);
    assert.deepEqual(warnings, []);
  } finally { process.off("warning", collect); }
});

test("legacy fills accepts additive per-call cancellation controls", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new KalshiClient({fetch: async () => {throw new Error("must not dispatch");}});
  await assert.rejects(client.portfolio.getFills({}, {signal: controller.signal}), KalshiAbortError);
});

test("each retry creates a fresh signature and timestamp", async () => {
  const {privateKey} = generateKeyPairSync("rsa", {modulusLength: 2048});
  const stamps: string[] = [];
  let timestamp = 1790000000000;
  const client = new KalshiClient({retry, auth: {apiKeyId: "test", privateKeyPem: privateKey, timestampProvider: () => String(timestamp++)}, fetch: async (_url, init) => {
    stamps.push(new Headers(init?.headers).get("kalshi-access-timestamp")!);
    return stamps.length === 1 ? Response.json({}, {status: 503}) : Response.json(statusBody);
  }});
  await client.getExchangeStatus();
  assert.deepEqual(stamps, ["1790000000000", "1790000000001"]);
});

test("real HTTP cancellation closes requests and redirect targets receive no credentials", {timeout: 5000}, async t => {
  let targetCalls = 0;
  let redirected = "";
  let stall = false;
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((request, response) => {
    if (stall) return;
    if (request.url === "/trade-api/v2/exchange/status") { response.writeHead(302, {location: redirected}); response.end(); }
    else {targetCalls++; response.end(JSON.stringify(statusBody));}
  });
  server.on("connection", socket => {sockets.add(socket); socket.on("close", () => sockets.delete(socket));});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  redirected = `http://127.0.0.1:${port}/credential-target`;
  const {privateKey} = generateKeyPairSync("rsa", {modulusLength: 2048});
  const client = new KalshiClient({environment: {name: "local", restBaseUrl: `http://127.0.0.1:${port}/trade-api/v2`, websocketUrl: `ws://127.0.0.1:${port}`}, auth: {apiKeyId: "private-id", privateKeyPem: privateKey}});
  await assert.rejects(client.getExchangeStatus(), KalshiTransportError);
  assert.equal(targetCalls, 0);
  stall = true;
  for (const timeout of [false, true]) {
    const requested = once(server, "request");
    const controller = new AbortController();
    const failure = assert.rejects(client.getExchangeStatus({}, {signal: controller.signal, timeoutMs: timeout ? 100 : 1000}), timeout ? KalshiTimeoutError : KalshiAbortError);
    const [request] = await requested;
    const closed = once(request.socket, "close");
    if (!timeout) controller.abort();
    await failure;
    await closed;
  }
});
