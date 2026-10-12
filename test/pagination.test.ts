import assert from "node:assert/strict";
import { constants, generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  KalshiClient, KalshiApiError, KalshiContractError, KalshiPaginationError,
  KalshiResponseParseError, isEndpointError, officialOperationSource,
  KalshiTransportError, KalshiAbortError, KalshiTimeoutError,
  type EndpointOptions, type PaginationOptions, type PaginatedOperationId
} from "../src/index.js";
import { operationContracts, contractComponents } from "../src/generated/contracts.js";
import { paginatePages } from "../src/pagination.js";

interface Coverage {
  operationId: PaginatedOperationId;
  pageMethod: string;
  domain: string;
  path: string;
  requiredParameters: { name: string; in: string }[];
  responses: { status: number; cursorField: string; cursorRequired: boolean; arrayFields: { name: string; required: boolean; itemSchema: { $ref?: string } }[] }[];
}
interface Fixture { operationId: string; input: { query?: Record<string, unknown>; pathParameters?: Record<string, unknown> }; responses: { status: number; body?: Record<string, unknown> }[] }
const coverage = JSON.parse(readFileSync("src/generated/pagination-coverage.json", "utf8")) as { sha256: string; paginatedOperationCount: number; operations: Coverage[] };
const fixtures = JSON.parse(readFileSync("test/typed-fixtures.json", "utf8")) as { fixtures: Fixture[]; schemaFixtures: { name: string; value: unknown }[] };
const expectedIds = [
  "GetBlockTradeProposals", "GetDeposits", "GetEventFeeChanges", "GetEvents", "GetFCMFills", "GetFCMOrders", "GetFCMPositions",
  "GetFills", "GetFillsHistorical", "GetHistoricalMarkets", "GetHistoricalOrders", "GetHistoricalPositions", "GetIncentivePrograms",
  "GetIntraExchangeInstanceTransfers", "GetMarkets", "GetMilestones", "GetMultivariateEventCollections", "GetMultivariateEvents",
  "GetOrders", "GetPositions", "GetQuotes", "GetRFQs", "GetSettlements", "GetStructuredTargets", "GetSubaccountTransfers",
  "GetTrades", "GetTradesHistorical", "GetWithdrawals"
];
type Pages = (input: Fixture["input"], options?: EndpointOptions, pagination?: PaginationOptions) => AsyncGenerator<Record<string, unknown>, void, unknown>;
const named = (client: KalshiClient, entry: Coverage, domain = false): Pages => {
  const target = domain ? (client as unknown as Record<string, unknown>)[entry.domain === "portfolioApi" ? "portfolio" : entry.domain] : client;
  return (target as Record<string, Pages>)[entry.pageMethod]!.bind(target);
};
function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}
const resolve = (schema: Record<string, unknown>): Record<string, unknown> => {
  if (!schema.$ref) return schema;
  return String(schema.$ref).slice("#/components/".length).split("/").reduce((value, key) => value[key] as Record<string, unknown>, contractComponents);
};
async function collect<T>(iterator: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterator) values.push(value);
  return values;
}

test("pagination coverage maps exactly all 28 source cursor-query operations and response fields", () => {
  assert.equal(coverage.sha256, officialOperationSource.sha256);
  assert.equal(coverage.paginatedOperationCount, 28);
  const ids = coverage.operations.map(e => e.operationId).sort();
  assert.deepEqual(ids, expectedIds);
  assert.deepEqual(ids, Object.entries(operationContracts).filter(([, op]) => op.parameters.some(p => p.in === "query" && p.name === "cursor")).map(([id]) => id).sort());
  for (const entry of coverage.operations) {
    const contract = operationContracts[entry.operationId]!;
    assert.deepEqual(entry.requiredParameters, contract.parameters.filter(p => p.required).map(p => ({ name: p.name, in: p.in })));
    for (const response of entry.responses) {
      const schema = resolve(contract.responses[String(response.status)]!.content!["application/json"]!.schema!);
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      assert.equal(properties[response.cursorField]!.type, "string");
      assert.equal(response.cursorRequired, ((schema.required ?? []) as string[]).includes(response.cursorField));
      assert.deepEqual(response.arrayFields.map(f => f.name).sort(), Object.entries(properties).filter(([, p]) => resolve(p).type === "array").map(([name]) => name).sort());
    }
  }
  assert.equal(coverage.operations.find(e => e.operationId === "GetIncentivePrograms")!.responses[0]!.cursorField, "next_cursor");
  assert.equal(coverage.operations.find(e => e.operationId === "GetStructuredTargets")!.responses[0]!.arrayFields[0]!.required, false);
  assert.equal(coverage.operations.find(e => e.operationId === "GetPositions")!.responses[0]!.arrayFields.length, 2);
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const timestamp = "1790000000000";

test("consumer cursor edits cannot redirect or truncate any named pager", async () => {
  for (const entry of coverage.operations) {
    const fixture = fixtures.fixtures.find(f => f.operationId === entry.operationId)!;
    const response = entry.responses[0]!;
    const original = fixture.responses.find(r => r.status === response.status)!.body!;
    for (const mutation of ["delete", "empty", "redirect"]) {
      const cursors: (string | null)[] = [];
      const client = new KalshiClient({fetch: async url => {
        cursors.push(new URL(url).searchParams.get("cursor"));
        return Response.json({...structuredClone(original), [response.cursorField]: cursors.length === 1 ? "server-next" : ""}, {status: response.status});
      }});
      const iterator = named(client, entry)(fixture.input, {authenticated: false});
      const first = (await iterator.next()).value!;
      if (mutation === "delete") delete first[response.cursorField];
      else first[response.cursorField] = mutation === "empty" ? "" : "consumer-invented";
      assert.equal((await iterator.next()).done, false, `${entry.operationId}: ${mutation}`);
      assert.equal(cursors[1], "server-next", `${entry.operationId}: ${mutation}`);
      assert.equal((await iterator.next()).done, true);
      assert.equal(cursors.length, 2);
    }
  }
});

test("all named pagers reject nonnullable null response cursors", async () => {
  for (const entry of coverage.operations) {
    const fixture = fixtures.fixtures.find(f => f.operationId === entry.operationId)!;
    const response = entry.responses[0]!;
    const body = fixture.responses.find(r => r.status === response.status)!.body!;
    const client = new KalshiClient({fetch: async () => Response.json({...structuredClone(body), [response.cursorField]: null}, {status: response.status})});
    await assert.rejects(named(client, entry)(fixture.input, {authenticated: false}).next(), KalshiContractError);
  }
});

for (const entry of coverage.operations) {
  test(`${entry.operationId}: multi-page loopback, auth, filters, bounds, cycles, laziness and failures`, { timeout: 15000 }, async t => {
    const fixture = fixtures.fixtures.find(f => f.operationId === entry.operationId)!;
    const responseContract = entry.responses[0]!;
    const errorResponse = fixture.responses.find(r => r.status >= 400 && r.status < 500)!;
    const { cursorField } = responseContract;
    const body = structuredClone(fixture.responses.find(r => r.status === responseContract.status)!.body!);
    for (const field of responseContract.arrayFields) {
      const model = field.itemSchema.$ref?.split("/").at(-1);
      if (model) body[field.name] = [structuredClone(fixtures.schemaFixtures.find(f => f.name === model)!.value)];
    }
    const makePage = (cursor: string | undefined, empty = false, omitOptionalArrays = false) => {
      const page = structuredClone(body);
      if (cursor === undefined) delete page[cursorField]; else page[cursorField] = cursor;
      if (empty) for (const field of responseContract.arrayFields) page[field.name] = [];
      if (omitOptionalArrays) for (const field of responseContract.arrayFields.filter(f => !f.required)) delete page[field.name];
      return page;
    };
    const terminal = responseContract.cursorRequired ? "" : undefined;
    const pages = [makePage("next /?&", true), makePage("last"), makePage(terminal, false, true)];
    const input: Fixture["input"] & { query: Record<string, unknown> & { cursor: string } } = freezeDeep({
      ...structuredClone(fixture.input), query: { ...structuredClone(fixture.input.query), cursor: "start /?&" }
    });
    const before = structuredClone(input);
    const options = freezeDeep({ authenticated: false, headers: { "X-Pagination-Proof": entry.operationId } });
    let replies: { status?: number; body?: unknown; raw?: string; disconnect?: boolean }[] = [];
    let requests: IncomingMessage[] = [];
    const failures: unknown[] = [];
    let signed = false;
    const server = createServer((request, response) => {
      try {
        const index = requests.length;
        requests.push(request);
        const reply = replies[index];
        assert.ok(reply, "no eager or extra HTTP request");
        const url = new URL(request.url!, "http://localhost");
        assert.equal(url.pathname, `/trade-api/v2${entry.path}`);
        assert.equal(request.method, "GET");
        assert.equal(request.headers["x-pagination-proof"], entry.operationId);
        const previous = replies[index - 1]?.body as Record<string, unknown> | undefined;
        const expectedCursor = index === 0 ? input.query.cursor : previous![cursorField];
        for (const parameter of operationContracts[entry.operationId]!.parameters.filter(p => p.in === "query")) {
          const value = parameter.name === "cursor" ? expectedCursor : input.query[parameter.name];
          if (value === undefined) assert.equal(url.searchParams.has(parameter.name), false);
          else assert.deepEqual(url.searchParams.getAll(parameter.name), Array.isArray(value)
            ? (parameter.explode ?? true) ? value.map(String) : [value.join(",")] : [String(value)]);
        }
        if (signed) {
          assert.equal(request.headers["kalshi-access-key"], "pagination-proof");
          assert.equal(request.headers["kalshi-access-timestamp"], timestamp);
          assert.equal(verify("sha256", Buffer.from(`${timestamp}GET${url.pathname}`), {
            key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST
          }, Buffer.from(String(request.headers["kalshi-access-signature"]), "base64")), true);
        } else assert.equal(request.headers["kalshi-access-key"], undefined);
        if (reply.disconnect) { request.socket.destroy(); return; }
        response.writeHead(reply.status ?? responseContract.status, { "content-type": "application/json" });
        response.end(reply.raw ?? JSON.stringify(reply.body));
      } catch (error) {
        failures.push(error);
        response.writeHead(500, { "content-type": "application/json" });
        response.end("{}");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    const port = (server.address() as AddressInfo).port;
    const client = new KalshiClient({ environment: { name: "pagination-loopback", restBaseUrl: `http://127.0.0.1:${port}/trade-api/v2`, websocketUrl: `ws://127.0.0.1:${port}` },
      auth: { apiKeyId: "pagination-proof", privateKeyPem: privateKey, timestampProvider: () => timestamp } });
    const reset = (values: typeof replies) => { replies = values; requests = []; };
    reset(pages.map(body => ({ body })));
    const iterator = named(client, entry)(input, options);
    assert.equal(requests.length, 0);
    for (const [index, page] of pages.entries()) {
      assert.deepEqual(await iterator.next(), { value: page, done: false });
      assert.equal(requests.length, index + 1);
    }
    assert.equal((await iterator.next()).done, true);
    assert.equal(requests.length, 3);

    reset(pages.map(body => ({ body })));
    for await (const page of named(client, entry, true)(input, options)) { assert.deepEqual(page, pages[0]); break; }
    assert.equal(requests.length, 1);

    reset(pages.map(body => ({ body })));
    const bounded = named(client, entry)(input, options, { maxPages: 2 });
    assert.equal((await collect(bounded)).length, 2);
    assert.equal(requests.length, 2);
    reset([]);
    assert.equal((await collect(named(client, entry)(input, options, { maxPages: 0 }))).length, 0);
    assert.equal(requests.length, 0);

    reset(["a", "b", "a"].map(cursor => ({ body: makePage(cursor) })));
    const cycle = named(client, entry)(input, options);
    for (let index = 0; index < 3; index++) assert.equal((await cycle.next()).done, false);
    await assert.rejects(cycle.next(), error => error instanceof KalshiPaginationError && error.operationId === entry.operationId && error.cursor === "a");
    assert.equal(requests.length, 3);
    reset([{ body: makePage(input.query.cursor) }]);
    const repeatedInitial = named(client, entry)(input, options);
    await repeatedInitial.next();
    await assert.rejects(repeatedInitial.next(), KalshiPaginationError);
    assert.equal(requests.length, 1);

    reset([{ body: makePage("") }]);
    assert.equal((await collect(named(client, entry)(input, options))).length, 1);
    if (!responseContract.cursorRequired) {
      reset([{ body: makePage(undefined) }]);
      assert.equal((await collect(named(client, entry)(input, options))).length, 1);
    } else {
      reset([{ body: makePage(undefined) }]);
      await assert.rejects(named(client, entry)(input, options).next(), KalshiContractError);
    }

    signed = true;
    reset([{ body: makePage("signed-next") }, { body: makePage(terminal) }]);
    assert.equal((await collect(named(client, entry, true)(input, { headers: options.headers, authenticated: true }))).length, 2);
    signed = false;
    reset([{ body: makePage("error-next") }, { status: errorResponse.status, body: errorResponse.body ?? {} }]);
    const failed = named(client, entry)(input, options);
    await failed.next();
    await assert.rejects(failed.next(), error => error instanceof KalshiApiError && error.status === errorResponse.status && isEndpointError(error, entry.operationId));
    assert.equal(requests.length, 2);
    assert.equal((await failed.next()).done, true);
    for (const reply of [{ body: 42 }, { raw: "{" }, { disconnect: true }]) {
      reset([{ body: makePage("error-next") }, reply]);
      const failed = named(client, entry)(input, options);
      await failed.next();
      await assert.rejects(failed.next(), reply.body === 42 ? KalshiContractError : reply.raw ? KalshiResponseParseError : KalshiTransportError);
      assert.equal(requests.length, 2);
    }
    assert.deepEqual(input, before);
    assert.deepEqual(options, { authenticated: false, headers: { "X-Pagination-Proof": entry.operationId } });
    assert.deepEqual(failures, []);
  });
}

test("limits and snapshots are preserved and pagination propagates client errors", async () => {
  const input = { pathParameters: { ticker: "A/B" }, query: { limit: 2, cursor: "start", tickers: ["A", "B"] } };
  const options = { authenticated: false, headers: { "X-Proof": "initial" } };
  const snapshots: unknown[] = [];
  const iterator = paginatePages("fixture", async (value, endpointOptions) => {
    snapshots.push(structuredClone({ value, endpointOptions }));
    return { cursor: snapshots.length === 1 ? "next" : "" };
  }, input, "cursor", options);
  input.pathParameters.ticker = "changed";
  input.query.tickers.push("changed");
  options.headers["X-Proof"] = "changed";
  assert.equal(snapshots.length, 0);
  await collect(iterator);
  assert.deepEqual(snapshots, ["start", "next"].map(cursor => ({ value: { pathParameters: { ticker: "A/B" }, query: { limit: 2, cursor, tickers: ["A", "B"] } }, endpointOptions: { authenticated: false, headers: { "X-Proof": "initial" } } })));
  const client = new KalshiClient({ fetch: async () => { throw new Error("no eager HTTP"); } });
  for (const maxPages of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => client.getMarketsPages({}, { authenticated: false }, { maxPages }), RangeError);
  }
  const failure = new Error("network identity");
  const failing = new KalshiClient({ fetch: async () => { throw failure; } });
  await assert.rejects(failing.getMarketsPages({}, { authenticated: false }).next(), KalshiTransportError);
  await assert.rejects(paginatePages("failure", async () => {throw failure;}, {}, "cursor").next(), error => error === failure);
  await assert.rejects(client.getMilestonesPages({ query: {} } as never, { authenticated: false }).next(), KalshiContractError);
  await assert.rejects(client.getMarketsPages({}, { authenticated: true }).next(), /requires auth/);
  await assert.rejects(client.getMarketsPages(null as never, { authenticated: false }).next(), KalshiContractError);
});

test("every named pager forwards cancellation and timeouts through real HTTP", {timeout: 20000}, async t => {
  let requestCount = 0;
  let body: Record<string, unknown> = {};
  let status = 200;
  const server = createServer((_request, response) => {
    requestCount++;
    if (requestCount === 1) {
      response.writeHead(status, {"content-type": "application/json"});
      response.end(JSON.stringify(body));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  const client = new KalshiClient({environment: {name: "pager-controls", restBaseUrl: `http://127.0.0.1:${port}/trade-api/v2`, websocketUrl: `ws://127.0.0.1:${port}`}});
  for (const entry of coverage.operations) {
    const fixture = fixtures.fixtures.find(f => f.operationId === entry.operationId)!;
    const response = entry.responses[0]!;
    for (const timeout of [false, true]) {
      requestCount = 0;
      status = response.status;
      body = {...structuredClone(fixture.responses.find(r => r.status === status)!.body!), [response.cursorField]: "server-next"};
      const controller = new AbortController();
      const pages = named(client, entry)(fixture.input, {authenticated: false, signal: controller.signal, timeoutMs: timeout ? 100 : 1000});
      assert.equal((await pages.next()).done, false);
      const received = once(server, "request");
      const failed = assert.rejects(pages.next(), timeout ? KalshiTimeoutError : KalshiAbortError);
      const [request] = await received;
      const closed = once((request as IncomingMessage).socket, "close");
      if (!timeout) controller.abort("SECRET_ABORT_REASON");
      await failed;
      await closed;
      assert.equal(requestCount, 2, entry.operationId);
      assert.equal((await pages.next()).done, true);
      assert.equal(requestCount, 2, "no dispatch after failure");
    }
  }
});

test("default page bound terminates unique cursors and iterator return performs no HTTP", async () => {
  let calls = 0;
  const iterator = paginatePages("bounded-fixture", async () => ({ cursor: String(++calls) }), {}, "cursor");
  assert.equal((await collect(iterator)).length, 1000);
  assert.equal(calls, 1000);
  const unstarted = paginatePages("early-stop", async () => { calls++; return { cursor: "next" }; }, {}, "cursor");
  await unstarted.return();
  assert.equal((await unstarted.next()).done, true);
  assert.equal(calls, 1000);
});

test("endpoint option snapshots preserve opaque transport values by identity", async () => {
  const signal = new AbortController().signal;
  const options = { authenticated: false, signal, headers: { "X-Proof": "initial" } };
  let calls = 0;
  const iterator = paginatePages("opaque-options", async (_input, forwarded) => {
    assert.equal((forwarded as typeof options).signal, signal);
    assert.equal(forwarded?.headers?.["X-Proof"], "initial");
    return { cursor: ++calls === 1 ? "next" : "" };
  }, {}, "cursor", options);
  options.headers["X-Proof"] = "changed";
  await collect(iterator);
  assert.equal(calls, 2);
});
