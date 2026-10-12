import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { inspect } from "node:util";
import { KalshiClient, KalshiApiError, KalshiInvalidResponseError, KalshiResponseParseError, KalshiResponseReadError, KalshiTimeoutError, KalshiAbortError, isEndpointError } from "../src/index.js";

const binary = Uint8Array.from([255, 254, 0, 65]);

test("raw and unspecified responses retain bytes instead of replacement text", async () => {
  const client = new KalshiClient({fetch: async () => new Response(binary, {status: 201})});
  const raw = await client.rawRequest("UpgradeAccountApiUsageLevel", {authenticated: false});
  assert.deepEqual(raw.rawBody, binary);
  assert.deepEqual(raw.body, binary);
  assert.ok(raw.body instanceof Uint8Array);
  raw.body[0] = 0;
  assert.deepEqual(raw.rawBody, binary, "decoded-body mutation must not alter original bytes");
  assert.deepEqual(await client.upgradeAccountApiUsageLevel({}, {authenticated: false}), binary);
});

test("decoded JSON, UTF-8 text, BOMs, octet streams and empty bodies keep original bytes", async () => {
  for (const [bytes, contentType, expected] of [
    [new TextEncoder().encode(' \n{"exchange_active":true,"trading_active":true}\n'), "application/json", {exchange_active: true, trading_active: true}],
    [Uint8Array.from([239, 187, 191, 123, 125]), "application/problem+json", {}],
    [Uint8Array.from([239, 187, 191, 65]), "text/plain", String.fromCharCode(0xfeff) + "A"],
    [Uint8Array.from([65, 66]), "application/octet-stream", Uint8Array.from([65, 66])],
    [new Uint8Array(), "application/json", undefined]
  ] as const) {
    const client = new KalshiClient({fetch: async () => new Response(bytes, {headers: {"content-type": contentType}})});
    const result = await client.rawRequest("GetExchangeStatus", {authenticated: false});
    assert.deepEqual(result.rawBody, bytes);
    assert.deepEqual(result.body, expected);
  }
});

test("malformed JSON errors expose exact bytes without copying snippets into diagnostics", async () => {
  for (const bytes of [binary, new TextEncoder().encode('{"SECRET_PRIVATE_KEY":')]) {
    const client = new KalshiClient({fetch: async () => new Response(bytes, {headers: {"content-type": "application/json", "request-id": "test"}})});
    await assert.rejects(client.getExchangeStatus(), error => {
      assert.ok(error instanceof KalshiResponseParseError);
      assert.equal(error.status, 200);
      assert.equal(error.headers?.get("request-id"), "test");
      assert.deepEqual(error.rawBody, bytes);
      assert.ok(!String(error.stack).includes("SECRET"));
      for (const output of [inspect(error, {depth: 10, showHidden: true}), JSON.stringify(error)]) {
        assert.ok(!output.includes("SECRET"));
        assert.ok(!output.includes("rawBody"));
      }
      return true;
    });
  }
});

test("generic, typed and invalid-schema failures preserve raw HTTP bytes", async () => {
  const client = new KalshiClient({fetch: async () => new Response(binary, {status: 401, headers: {"retry-after": "7"}})});
  await assert.rejects(client.rawRequest("GetFCMOrders", {authenticated: false}), error => {
    assert.ok(error instanceof KalshiApiError);
    assert.deepEqual(error.rawBody, binary);
    assert.deepEqual(error.body, binary);
    assert.equal(error.headers.get("retry-after"), "7");
    return true;
  });
  await assert.rejects(client.getFCMOrders({query: {subtrader_id: "test"}}, {authenticated: false}), error => {
    assert.ok(isEndpointError(error, "GetFCMOrders"));
    assert.deepEqual(error.rawBody, binary);
    return true;
  });
  const invalid = new KalshiClient({fetch: async () => new Response(binary, {status: 503})});
  await assert.rejects(invalid.getExchangeStatus(), error => error instanceof KalshiInvalidResponseError && error.status === 503 && assert.deepEqual(error.rawBody, binary) === undefined);
  const privateBody = new KalshiClient({fetch: async () => Response.json({private_key: "SECRET_PRIVATE_KEY"}, {status: 418, statusText: "SECRET_STATUS_TEXT"})});
  await assert.rejects(privateBody.getExchangeStatus(), error => {
    assert.ok(error instanceof KalshiApiError);
    assert.equal(error.statusText, "SECRET_STATUS_TEXT");
    for (const output of [inspect(error, {depth: 10, showHidden: true}), JSON.stringify(error), String(error.stack)]) assert.ok(!output.includes("SECRET"));
    assert.ok(error.rawBody?.length);
    return true;
  });
});

test("real HTTP retains arbitrary binary and success headers", {timeout: 5000}, async t => {
  const server = createServer((_request, response) => {
    response.writeHead(201, {"content-type": "application/octet-stream", "request-id": "wire"});
    response.write(Buffer.from(binary.subarray(0, 2)));
    response.end(Buffer.from(binary.subarray(2)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  const client = new KalshiClient({environment: {name: "binary", restBaseUrl: `http://127.0.0.1:${port}/trade-api/v2`, websocketUrl: `ws://127.0.0.1:${port}`}});
  const result = await client.rawRequest("UpgradeAccountApiUsageLevel", {authenticated: false});
  assert.equal(result.response.status, 201);
  assert.equal(result.response.headers.get("request-id"), "wire");
  assert.deepEqual(result.body, binary);
  assert.deepEqual(result.rawBody, binary);
});

test("media casing and charset labels cannot trigger lossy decoding", async () => {
  const body = new TextEncoder().encode('{"exchange_active":true,"trading_active":true}');
  for (const contentType of ["APPLICATION/JSON; Charset=UTF-8", "application/vendor+json; charset=utf-8"]) {
    const client = new KalshiClient({fetch: async () => new Response(body, {headers: {"content-type": contentType}})});
    const result = await client.rawRequest("GetExchangeStatus", {authenticated: false});
    assert.deepEqual(result.body, {exchange_active: true, trading_active: true});
    assert.deepEqual(result.rawBody, body);
  }
  const bytes = Uint8Array.from([169]);
  const client = new KalshiClient({fetch: async () => new Response(bytes, {headers: {"content-type": "text/plain; charset=iso-8859-1"}})});
  assert.deepEqual((await client.rawRequest("GetExchangeStatus", {authenticated: false})).body, bytes);
});

test("partial real HTTP bodies never masquerade as complete raw bytes", {timeout: 5000}, async t => {
  let socket: import("node:net").Socket;
  const server = createServer((request, response) => {
    socket = request.socket;
    response.writeHead(200, {"content-type": "application/json", "request-id": "partial"});
    response.write('{"exchange_active":true,');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  for (const mode of ["abort", "timeout", "disconnect"]) {
    let seen!: () => void;
    const headersSeen = new Promise<void>(resolve => {seen = resolve;});
    const controller = new AbortController();
    const client = new KalshiClient({environment: {name: "partial", restBaseUrl: `http://127.0.0.1:${port}/trade-api/v2`, websocketUrl: `ws://127.0.0.1:${port}`}, fetch: async (url, init) => {
      const response = await fetch(url, init);
      seen();
      return response;
    }});
    const failed = assert.rejects(client.getExchangeStatus({}, {signal: controller.signal, timeoutMs: 1000}), error => {
      if (mode === "abort") assert.ok(error instanceof KalshiAbortError);
      else if (mode === "timeout") assert.ok(error instanceof KalshiTimeoutError);
      else {
        assert.ok(error instanceof KalshiResponseReadError);
        assert.equal(error.status, 200);
        assert.equal(error.headers.get("request-id"), "partial");
        assert.equal(error.rawBody, undefined);
      }
      return true;
    });
    await headersSeen;
    if (mode === "abort") controller.abort();
    else if (mode === "disconnect") socket!.destroy();
    await failed;
  }
});
