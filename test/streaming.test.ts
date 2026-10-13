import assert from "node:assert/strict";
import { constants, generateKeyPairSync, verify, createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { predictionsWsContract } from "../src/generated/predictions-ws-contracts.js";
import { perpsWsContract } from "../src/generated/perps-ws-contracts.js";
import { KalshiPredictionsWebSocketClient, KalshiPerpsWebSocketClient, KalshiContractError, KalshiWebSocketBackpressureError, KalshiWebSocketPartialSubscriptionError, KalshiTimeoutError } from "../src/index.js";
import { StreamingSession, type StreamingClientOptions } from "../src/streaming/session.js";
import { StreamingValidator, type StreamingContract, type Schema } from "../src/streaming/contracts.js";
import { BookStore } from "../src/streaming/orderbook.js";
import { BoundedQueue } from "../src/streaming/queue.js";
import { internalHandle } from "../src/streaming/handle.js";

const contract = predictionsWsContract as unknown as StreamingContract;
const data = JSON.parse(readFileSync("test/predictions-ws-fixtures.json", "utf8"));
const perpsData = JSON.parse(readFileSync("test/perps-ws-fixtures.json", "utf8"));
const source = (name: string, product = "predictions") => structuredClone((product === "predictions" ? data : perpsData).fixtures.find((f: Schema) => f.name === name).payload) as Schema;
const ticker = "KXHIGHNY-26OCT12-B75.5";
const ticker2 = "KXHIGHNY-26OCT12-B73.5";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error("Event barrier timed out."); await tick(); }
}
type Peer = { socket: WebSocket; subscriptions: Map<number, { channel: string; params: Schema }>; sequence: Map<number, number> };
async function harness<P extends "predictions"|"perps" = "predictions">(t: TestContext, options: Partial<StreamingClientOptions> = {}, handler?: (peer: Peer, command: Schema) => boolean, product: P = "predictions" as P): Promise<{
  client: P extends "perps" ? KalshiPerpsWebSocketClient : KalshiPredictionsWebSocketClient; session: StreamingSession; peers: Peer[]; commands: Schema[]; send: (peer: Peer, name: string, sid: number, changes?: Schema) => Schema;
}> {
  const activeContract = (product === "predictions" ? predictionsWsContract : perpsWsContract) as unknown as StreamingContract;
  const model = (name: string) => source(name, product);
  const apiPath = product === "predictions" ? "/trade-api/ws/v2" : "/trade-api/ws/v2/margin";
  const peers: Peer[] = [], commands: Schema[] = [], failures: unknown[] = [];
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let stamp = 1790000000000;
  const handshakeStamps: string[] = [];
  http.on("upgrade", (request, socket, head) => {
    try {
      assert.equal(request.url, apiPath);
      assert.equal(request.headers["kalshi-access-key"], "streaming-test");
      const timestamp = String(request.headers["kalshi-access-timestamp"]);
      if (handshakeStamps.length) assert.ok(Number(timestamp) > Number(handshakeStamps.at(-1)));
      handshakeStamps.push(timestamp);
      assert.equal(verify("sha256", Buffer.from(`${timestamp}GET${apiPath}`), { key: keys.publicKey,
        padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(String(request.headers["kalshi-access-signature"]), "base64")), true);
      wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws));
    } catch (error) { failures.push(error); socket.destroy(); }
  });
  const send = (peer: Peer, name: string, sid: number, changes: Schema = {}) => {
    const message: Schema = { ...model(name), ...changes, sid };
    if (activeContract.components.schemas[activeContract.components.messages[name]!.payload.$ref?.split("/").at(-1)]?.properties?.seq) {
      message.seq = changes.seq ?? (peer.sequence.get(sid) ?? 0) + 1; peer.sequence.set(sid, message.seq);
    }
    message.sending_ts_ms = 1790000000000;
    peer.socket.send(JSON.stringify(message)); return message;
  };
  wss.on("connection", socket => {
    const peer: Peer = { socket, subscriptions: new Map(), sequence: new Map() }; peers.push(peer);
    socket.on("error", () => {});
    socket.on("message", raw => {
      try {
        const command = JSON.parse(raw.toString()); commands.push(command);
        if (handler?.(peer, command)) return;
        const params = command.params;
        if (command.cmd === "subscribe") {
          for (const channel of [...params.channels].reverse()) {
            const sid = peers.length * 100 + peer.subscriptions.size + 1;
            peer.subscriptions.set(sid, { channel, params: structuredClone(params) });
            socket.send(JSON.stringify({ id: command.id, type: "subscribed", msg: { channel, sid }, sending_ts_ms: 1790000000000 }));
            if (channel === "orderbook_delta") for (const market of params.market_tickers ?? [params.market_ticker]) {
              send(peer, "orderbookSnapshot", sid, { msg: { ...model("orderbookSnapshot").msg, market_ticker: market,
                ...(product === "predictions" ? {yes_dollars_fp:[["0.1000","0.10"]],no_dollars_fp:[["0.2000","1.00"]]} : {bid:[["123.4500","0.10"]],ask:[["124.5600","1.00"]]}) } });
            }
          }
        } else if (command.cmd === "list_subscriptions") socket.send(JSON.stringify({ id: command.id, type: "ok", msg: [...peer.subscriptions].map(([sid, value]) => ({ sid, channel: value.channel })) }));
        else if (command.cmd === "unsubscribe") for (const sid of params.sids) { peer.subscriptions.delete(sid); send(peer, "unsubscribedResponse", sid, { id: command.id }); }
        else if (params.action === "get_snapshot") for (const market of params.market_tickers) {
          send(peer, "orderbookSnapshot", params.sid ?? params.sids[0], { id: command.id, msg: { ...model("orderbookSnapshot").msg, market_ticker: market } });
        } else if (params.action === "indexlist") send(peer, peer.subscriptions.get(params.sid)!.channel === "cfbenchmarks_value" ? "cfbenchmarksIndexList" : "cfbenchmarks5HzIndexList", params.sid, { id: command.id, msg: { index_ids: ["BRTI"] } });
        else if (params.action === "underlying_list") send(peer, "pythUnderlyingList", params.sid, { id: command.id, msg: { underlying_tickers: ["Metal.XAU/USD"] } });
        else if (params.action.includes("indices")) send(peer, "subscribedIndicesResponse", params.sid, { id: command.id, msg: { index_ids: params.index_ids } });
        else if (params.action.includes("underlyings")) send(peer, "subscribedUnderlyingsResponse", params.sid, { id: command.id, msg: { underlying_tickers: params.underlying_tickers } });
        else send(peer, "okResponse", params.sid, { id: command.id, msg: { market_tickers: params.market_tickers ?? [] } });
      } catch (error) { failures.push(error); socket.terminate(); }
    });
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}${apiPath}`;
  const config: StreamingClientOptions = { auth: { apiKeyId: "streaming-test", privateKeyPem: keys.privateKey, timestampProvider: () => String(stamp++) },
    url, reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 }, ...options };
  const client = (product === "predictions" ? new KalshiPredictionsWebSocketClient(config) : new KalshiPerpsWebSocketClient(config)) as P extends "perps" ? KalshiPerpsWebSocketClient : KalshiPredictionsWebSocketClient;
  const session = new StreamingSession(activeContract, config);
  t.after(async () => {
    await client.close(); await session.close();
    for (const peer of peers) peer.socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
    assert.deepEqual(failures, []);
  });
  return { client, session, peers, commands, send };
}

test("source coverage: exact accounting, all 44 components and 50 schema fixtures, narrow Core issue 12 rules", () => {
  assert.deepEqual(data.counts, { channels: 15, operations: 41, bindings: 44, components: 44, schemas: 50 });
  const coverage = JSON.parse(readFileSync("src/generated/predictions-ws-coverage.json", "utf8"));
  assert.equal(coverage.channels.length, 15); assert.equal(coverage.operations.length, 41);
  assert.deepEqual(coverage.supplemental, ["updateSubscriptionGetSnapshotCommand"]);
  const validator = new StreamingValidator(contract);
  for (const fixture of data.fixtures) {
    validator.validate(fixture.name, fixture.payload);
    assert.throws(() => validator.validate(fixture.name, true), KalshiContractError);
  }
  for (const fixture of data.schemas) {
    validator.validateSchema(fixture.name, fixture.value);
    const invalid = typeof fixture.value === "string" ? 42 : typeof fixture.value === "number" || fixture.value === null ? {} : 42;
    assert.throws(() => validator.validateSchema(fixture.name, invalid), KalshiContractError);
  }
  const gaps = JSON.parse(readFileSync("src/generated/predictions-ws-source-gaps.json", "utf8"));
  assert.deepEqual(gaps.rules.map((r: Schema) => r.pointer), ["#/components/schemas/marketTicker/pattern", "#/components/messages/incomingPong/payload/const", "#/components/messages/outgoingPing/payload/const"]);
  for (const rule of gaps.rules) assert.equal(rule.issue, "https://github.com/hurley451/KalshiCore/issues/12");
  validator.validateSchema("marketTicker", ticker);
  for (const invalid of ["bad/ticker", "lowercase", 42, ""]) assert.throws(() => validator.validateSchema("marketTicker", invalid), KalshiContractError);
  assert.throws(() => validator.validateSchema("marketId", "not-a-uuid"), KalshiContractError);
  assert.throws(() => validator.validate("incomingPong", "heartbeat"), KalshiContractError);
  validator.validateControl("incomingPong", Buffer.from("heartbeat"), Buffer.from("heartbeat"));
  assert.throws(() => validator.validateControl("incomingPong", Buffer.from(""), Buffer.from("heartbeat")), KalshiContractError);
  assert.throws(() => validator.validateControl("incomingPong", Buffer.from("other")), KalshiContractError);
});

for (const channel of Object.keys(contract.channels).filter(c => !["root", "control_frames"].includes(c))) {
  test(`Predictions ${channel}: real transport, every source message, typed metadata and channel commands`, { timeout: 5000 }, async t => {
    const { client, peers, send } = await harness(t);
    assert.equal(peers.length, 0); await client.connect();
    const params = channel === "orderbook_delta" ? { market_tickers: [ticker], use_yes_price: true } : channel.startsWith("cfbenchmarks") ? { index_ids: ["BRTI"] }
      : channel === "pyth_value" ? { underlying_tickers: ["Metal.XAU/USD"] } : {};
    const handle = await (client.subscribe as any)(channel, params, { id: 17 });
    const peer = peers[0]!;
    if (channel === "orderbook_delta") await handle.messages().next();
    for (const component of contract.channels[channel]!) {
      const message = source(component);
      delete message.seq;
      if (message.msg?.market_ticker) message.msg.market_ticker = ticker;
      if (component === "orderbookDelta") Object.assign(message.msg, { price_dollars: "0.1000", delta_fp: "0.20", side: "yes" });
      const expected = send(peer, component, handle.sid, message);
      assert.deepEqual((await handle.messages().next()).value, expected);
    }
    if (["orderbook_delta", "ticker", "fill", "user_orders"].includes(channel)) {
      assert.equal((await handle.update({ action: "add_markets", market_tickers: [ticker2] })).type, "ok");
      await handle.update({ action: "delete_markets", market_tickers: [ticker2] });
    }
    if (channel.startsWith("cfbenchmarks")) { await handle.indexList(); await handle.subscribeIndices(["ETHUSD_RTI"]); await handle.unsubscribeIndices(["ETHUSD_RTI"]); }
    if (channel === "pyth_value") { await handle.underlyingList(); await handle.subscribeUnderlyings(["Metal.XPT/USD"]); await handle.unsubscribeUnderlyings(["Metal.XPT/USD"]); }
    const listed = await client.listSubscriptions(); assert.deepEqual(listed.msg, [{ channel, sid: handle.sid }]);
    await handle.unsubscribe(); assert.deepEqual((await client.listSubscriptions()).msg, []);
  });
}

test("native Ping/Pong has exactly one automatic echo owner, independent of an overflowing event queue", async t => {
  const { client, peers } = await harness(t, { limits: { queueMessages: 1 } });
  await client.connect();
  let pongs = 0;
  peers[0]!.socket.on("pong", bytes => { assert.equal(bytes.toString(), "heartbeat"); pongs++; });
  peers[0]!.socket.ping("heartbeat"); await until(() => pongs === 1);
  await client.ping(); await tick(); assert.equal(pongs, 1);
  await assert.rejects(client.events().next(), KalshiWebSocketBackpressureError);
});

test("getSnapshot completes every requested market with matching generation/id/SID and atomic empty-side replacement", async t => {
  let snapshotCommand: Schema | undefined;
  const { client, peers, send } = await harness(t, {}, (_peer, command) => {
    if (command.params?.action === "get_snapshot") { snapshotCommand = command; return true; } return false;
  });
  await client.connect();
  const handle = await client.subscribe("orderbook_delta", { market_tickers: [ticker, ticker2], use_yes_price: true });
  await handle.messages().next(); await handle.messages().next();
  const pending = handle.getSnapshot([ticker, ticker2]);
  await until(() => snapshotCommand !== undefined);
  let completed = false; void pending.then(() => { completed = true; });
  const peer = peers[0]!, id = snapshotCommand!.id;
  send(peer, "orderbookSnapshot", handle.sid, { id: id + 100, msg: { ...source("orderbookSnapshot").msg, market_ticker: ticker } });
  await handle.messages().next(); assert.equal(completed, false);
  send(peer, "orderbookSnapshot", handle.sid, { id, msg: { ...source("orderbookSnapshot").msg, market_ticker: ticker } });
  await handle.messages().next(); assert.equal(completed, false); assert.deepEqual(handle.book(ticker)?.yes, []); assert.deepEqual(handle.book(ticker)?.no, []);
  send(peer, "orderbookDelta", handle.sid, { msg: { ...source("orderbookDelta").msg, market_ticker: ticker, price_dollars: "0.1000", delta_fp: "0.20", side: "yes" } });
  await handle.messages().next(); assert.deepEqual(handle.book(ticker)?.yes, [["0.1", "0.2"]]);
  send(peer, "orderbookSnapshot", handle.sid, { id, msg: { ...source("orderbookSnapshot").msg, market_ticker: ticker2 } });
  assert.equal((await pending).length, 2); assert.equal(handle.book(ticker2)?.ready, true);
});

test("ack/error sequence numbers participate in continuity and a gap invalidates every book under the SID", async t => {
  let requested: Schema | undefined;
  const { client, peers, send } = await harness(t, {}, (_peer, command) => {
    if (command.params?.action === "get_snapshot") { requested = command; return true; } return false;
  });
  await client.connect(); const handle = await client.subscribe("orderbook_delta", { market_tickers: [ticker, ticker2] });
  await handle.messages().next(); await handle.messages().next();
  await handle.update({ action: "add_markets", market_tickers: [ticker2] });
  send(peers[0]!, "errorResponse", handle.sid, { msg: { code: 7, msg: "scoped" } });
  const last = peers[0]!.sequence.get(handle.sid)!;
  send(peers[0]!, "orderbookDelta", handle.sid, { seq: last + 1, msg: { ...source("orderbookDelta").msg, market_ticker: ticker, price_dollars: "0.1000", delta_fp: "0.20", side: "yes" } });
  await handle.messages().next(); assert.equal(handle.book(ticker)?.ready, true); assert.equal(requested, undefined);
  send(peers[0]!, "orderbookDelta", handle.sid, { seq: last + 3, msg: { ...source("orderbookDelta").msg, market_ticker: ticker, price_dollars: "0.1000", delta_fp: "0.20", side: "yes" } });
  await until(() => requested !== undefined);
  assert.equal(handle.book(ticker)?.ready, false); assert.equal(handle.book(ticker2)?.ready, false);
  assert.deepEqual(new Set(requested!.params.market_tickers), new Set([ticker, ticker2]));
  for (const market of [ticker, ticker2]) send(peers[0]!, "orderbookSnapshot", handle.sid, { id: requested!.id, msg: { ...source("orderbookSnapshot").msg, market_ticker: market } });
  await until(() => handle.book(ticker2)?.ready === true);
});

test("subscribeMany out-of-order acknowledgements preserve IDs; partial success fences and removes inaccessible subscriptions", async t => {
  const { client, peers } = await harness(t, {}, (peer, command) => {
    if (command.cmd === "subscribe" && command.params.channels.includes("fill")) {
      peer.socket.send(JSON.stringify({ id: command.id, type: "subscribed", msg: { channel: "trade", sid: 777 } }));
      peer.socket.send(JSON.stringify({ id: command.id, type: "error", msg: { code: 10, msg: "channel unavailable" } })); return true;
    } return false;
  });
  await client.connect();
  const handles = await client.subscribeMany({ channels: ["trade", "ticker"] }, { id: 100 });
  assert.deepEqual(handles.map(h => h.channel), ["ticker", "trade"]);
  await assert.rejects(client.subscribe("trade", {}, { id: 100 }), /unused positive/);
  const before = client.generation;
  await assert.rejects(client.subscribeMany({ channels: ["trade", "fill"] }), error => error instanceof KalshiWebSocketPartialSubscriptionError && error.acknowledgedChannels.includes("trade"));
  await until(() => peers.length === 2 && handles.every(h => h.generation === client.generation));
  assert.ok(client.generation > before); assert.equal(peers[0]!.socket.readyState, WebSocket.CLOSED);
  assert.deepEqual((await client.listSubscriptions()).msg.map(v => v.channel).sort(), ["ticker", "trade"]);
});

test("mutation wire order, queued cancellation, timeout uncertainty fences and restores only acknowledged filters", async t => {
  let held: Schema | undefined;
  const { client, peers, commands } = await harness(t, {}, (_peer, command) => {
    if (command.params?.action === "add_markets" && command.params.market_tickers.includes("KXUNCERTAIN")) { held = command; return true; } return false;
  });
  await client.connect(); const handle = await client.subscribe("ticker", { market_tickers: [ticker] });
  await Promise.all([handle.update({ action: "add_markets", market_tickers: [ticker2] }), handle.update({ action: "delete_markets", market_tickers: [ticker] })]);
  assert.deepEqual(commands.filter(c => c.cmd === "update_subscription").map(c => c.params.action), ["add_markets", "delete_markets"]);
  const timeout = handle.update({ action: "add_markets", market_tickers: ["KXUNCERTAIN"] }, { timeoutMs: 50 });
  const controller = new AbortController();
  const canceled = handle.update({ action: "add_markets", market_tickers: ["KXCANCELED"] }, { signal: controller.signal });
  await until(() => held !== undefined); controller.abort(); await assert.rejects(canceled, /cancel/i);
  await assert.rejects(timeout, KalshiTimeoutError);
  await until(() => peers.length === 2 && handle.generation === client.generation);
  const restored = commands.filter(c => c.cmd === "subscribe").at(-1)!;
  assert.deepEqual(restored.params.market_tickers, [ticker2]);
  assert.equal(commands.some(c => c.params?.market_tickers?.includes("KXCANCELED")), false);
});

test("book decimal arithmetic is string-only, canonical, exact, atomic, bounded, and converts no-leg pricing once", () => {
  const book = new BookStore("predictions", false, 128, 10);
  const snapshot = { sid: 1, seq: 1, msg: { market_ticker: ticker, yes_dollars_fp: [["0.1000", "9007199254740993.10"]], no_dollars_fp: [["0.2000", "1.00"]] } };
  book.snapshot(snapshot);
  book.delta({ sid: 1, seq: 2, msg: { market_ticker: ticker, side: "yes", price_dollars: "0.10", delta_fp: "0.20" } });
  assert.deepEqual(book.get(ticker, 1, 1)?.yes, [["0.1", "9007199254740993.3"]]);
  assert.deepEqual(book.get(ticker, 1, 1)?.no, [["0.8", "1"]]);
  const before = book.get(ticker, 1, 1);
  for (const delta of ["-99999999999999999.00", "NaN", "1e100000", "1".repeat(129), 1]) {
    assert.throws(() => book.delta({ sid: 1, seq: 3, msg: { market_ticker: ticker, side: "yes", price_dollars: "0.10", delta_fp: delta } }), KalshiContractError);
    assert.deepEqual(book.get(ticker, 1, 1), before);
  }
  assert.throws(() => book.snapshot({ ...snapshot, msg: { ...snapshot.msg, no_dollars_fp: [["0.2", "-1"]] } }), KalshiContractError);
  assert.deepEqual(book.get(ticker, 1, 1), before);
  book.snapshot({ sid: 1, seq: 4, msg: { market_ticker: ticker } }); assert.deepEqual(book.get(ticker, 1, 1)?.yes, []); assert.deepEqual(book.get(ticker, 1, 1)?.no, []);
});

test("book state rejects excess markets and computed decimal/level overflow atomically; deleting filters prunes state", () => {
  const book = new BookStore("perps",false,4,1,1);
  book.snapshot({sid:1,seq:1,msg:{market_ticker:ticker,bid:[["1","9999"]]}});
  assert.throws(()=>book.snapshot({sid:1,seq:2,msg:{market_ticker:ticker2}}),KalshiContractError);
  assert.throws(()=>book.delta({sid:1,seq:2,msg:{market_ticker:ticker,side:"bid",price:"1",delta:"1"}}),KalshiContractError);
  assert.throws(()=>book.delta({sid:1,seq:2,msg:{market_ticker:ticker,side:"ask",price:"2",delta:"1"}}),KalshiContractError);
  assert.deepEqual(book.get(ticker,1,1)?.yes,[["1","9999"]]);
  book.retain([]);assert.equal(book.get(ticker,1,1),undefined);
  book.snapshot({sid:1,seq:3,msg:{market_ticker:ticker2}});assert.equal(book.get(ticker2,1,1)?.ready,true);
});

test("bounded queue settles waiters and rejects count/byte overflow without dropping an accepted message", async () => {
  const queue = new BoundedQueue<number>(1, 1, () => 1);
  queue.push(1, 1); assert.throws(() => queue.push(2, 1), KalshiWebSocketBackpressureError);
  assert.deepEqual(await queue.next(), { value: 1, done: false });
  const waiter = queue.next(); queue.end(); assert.equal((await waiter).done, true);
});

test("a terminal queue failure remains observable after repeated close for late consumers", async ()=>{
  const queue=new BoundedQueue<string>(1,10,()=>1);
  const error=new Error("terminal stream failure");queue.end(error);queue.end();
  await assert.rejects(queue.next(),error);await assert.rejects(queue.next(),error);
});

test("close cancels commands, probes and receive waiters and cannot restart reconnect", async t => {
  const { client, peers } = await harness(t, { closeTimeoutMs: 10 }, (_peer, command) => command.cmd === "list_subscriptions");
  await client.connect(); const handle = await client.subscribe("trade");
  const pending = client.listSubscriptions(); const rejected = assert.rejects(pending, /closed/);
  const receive = handle.messages().next(); await client.close(); await rejected;
  assert.equal((await receive).done, true); assert.equal(client.state, "closed");
  await assert.rejects(client.connect(), /closed/); await tick(); assert.equal(peers.length, 1);
});

test("snapshot correlation ignores another SID and another market even with the right command ID", async t => {
  let command: Schema | undefined;
  const { client, peers, send } = await harness(t, {}, (_peer, value) => {
    if (value.params?.action === "get_snapshot") { command = value; return true; } return false;
  });
  await client.connect();
  const a = await client.subscribe("orderbook_delta", { market_tickers: [ticker] });
  const b = await client.subscribe("orderbook_delta", { market_tickers: [ticker2] });
  await a.messages().next(); await b.messages().next();
  const result = a.getSnapshot([ticker]); await until(() => command !== undefined);
  let finished = false; void result.then(() => { finished = true; });
  send(peers[0]!, "orderbookSnapshot", b.sid, { id: command!.id, msg: { ...source("orderbookSnapshot").msg, market_ticker: ticker2 } });
  await b.messages().next(); assert.equal(finished, false);
  send(peers[0]!, "orderbookSnapshot", a.sid, { id: command!.id, msg: { ...source("orderbookSnapshot").msg, market_ticker: ticker2 } });
  await a.messages().next(); assert.equal(finished, false);
  send(peers[0]!, "orderbookSnapshot", a.sid, { id: command!.id, msg: { ...source("orderbookSnapshot").msg, market_ticker: ticker } });
  assert.equal((await result).length, 1);
});

for (const fault of ["malformed-sequence", "queue-overflow", "invalid-json", "oversized-frame"] as const) {
  test(`${fault}: fences generation and invalidates all books for the SID`, { timeout: 5000 }, async t => {
    let pauseRestore = false;
    const { client, peers, send } = await harness(t, { limits: { queueMessages: 2, maxPayloadBytes: 2048 } }, (_peer, command) => pauseRestore && command.cmd === "subscribe");
    await client.connect(); const handle = await client.subscribe("orderbook_delta", { market_tickers: [ticker, ticker2] });
    await handle.messages().next(); await handle.messages().next();
    const before = client.generation; pauseRestore = true;
    if (fault === "invalid-json") peers[0]!.socket.send("{");
    else if (fault === "oversized-frame") peers[0]!.socket.send("x".repeat(2049));
    else {
      for (let i = 0; i < (fault === "queue-overflow" ? 3 : 1); i++) {
        send(peers[0]!, "orderbookDelta", handle.sid, { ...(fault === "malformed-sequence" ? { seq: 1.5 } : {}),
          msg: { ...source("orderbookDelta").msg, market_ticker: ticker, price_dollars: "0.1000", delta_fp: "0.20", side: "yes" } });
      }
    }
    await until(() => client.generation > before);
    assert.notEqual(handle.book(ticker)?.ready, true); assert.notEqual(handle.book(ticker2)?.ready, true);
  });
}

test("outbound and pending limits reject before wire mutation; pre-abort performs no upgrade", async t => {
  const { client, peers, commands } = await harness(t, { limits: { outboundBytes: 180, pendingCommands: 1 } }, (_peer, command) => command.cmd === "list_subscriptions");
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(client.connect({ signal: aborted.signal }), /cancel/); assert.equal(peers.length, 0);
  await client.connect();
  const handle = await client.subscribe("ticker", { market_tickers: [ticker] });
  const before = commands.length;
  await assert.rejects(handle.update({ action: "add_markets", market_tickers: ["KX" + "A".repeat(200)] }), KalshiWebSocketBackpressureError);
  assert.equal(commands.length, before);
  const pending = client.listSubscriptions(); const rejected = assert.rejects(pending, /closed/);
  await assert.rejects(client.listSubscriptions(), KalshiWebSocketBackpressureError);
  await client.close(); await rejected;
});

test("queued snapshots use filters acknowledged by preceding mutations, never stale caller-time filters", async t=>{
  const {client,commands}=await harness(t);await client.connect();
  const handle=await client.subscribe("orderbook_delta",{market_tickers:[ticker]});
  const adding=handle.update({action:"add_markets",market_tickers:[ticker2]});
  const snapshot=handle.getSnapshot([ticker2]);await adding;assert.equal((await snapshot)[0]?.msg.market_ticker,ticker2);
  const removing=handle.update({action:"delete_markets",market_tickers:[ticker2]});
  const stale=assert.rejects(handle.getSnapshot([ticker2]),KalshiContractError);await removing;await stale;
  assert.equal(commands.filter(c=>c.params?.action==="get_snapshot").length,1);
});

test("per-handle mutation backlog stays bounded even when queued callers cancel before wire", async t=>{
  let blocked:Schema|undefined;
  const {client,peers,send,commands}=await harness(t,{limits:{pendingCommands:2}},(_peer,command)=>{
    if(command.params?.action==="add_markets"&&!blocked){blocked=command;return true;}return false;
  });
  await client.connect();const handle=await client.subscribe("ticker",{market_tickers:[ticker]});
  const first=handle.update({action:"add_markets",market_tickers:[ticker2]});await until(()=>blocked!==undefined);
  const controller=new AbortController();
  const second=handle.update({action:"delete_markets",market_tickers:[ticker2]},{signal:controller.signal});
  controller.abort();await assert.rejects(second);
  await assert.rejects(handle.update({action:"add_markets",market_tickers:[ticker2]}),KalshiWebSocketBackpressureError);
  send(peers[0]!,"okResponse",handle.sid,{id:blocked!.id,msg:{market_tickers:[ticker,ticker2]}});await first;await tick();
  assert.equal(commands.filter(c=>c.cmd==="update_subscription").length,1);
  await handle.update({action:"delete_markets",market_tickers:[ticker2]});
});

test("cancel or close immediately after connect prevents the deferred HTTP upgrade", async t=>{
  const {client,peers}=await harness(t);
  const controller=new AbortController();
  const connecting=client.connect({signal:controller.signal});controller.abort();
  await assert.rejects(connecting);await tick();assert.equal(peers.length,0);
  const again=client.connect();const closing=client.close();
  await assert.rejects(again);await closing;await tick();assert.equal(peers.length,0);assert.equal(client.state,"closed");
});

test("frames before subscribe acknowledgement bind safely; old-generation callbacks cannot affect a rebound SID", async t => {
  const { client, peers } = await harness(t, {}, (peer, command) => {
    if (command.cmd === "subscribe" && command.params.channels[0] === "trade") {
      const sid = 101;
      peer.subscriptions.set(sid, { channel: "trade", params: command.params });
      peer.socket.send(JSON.stringify({ ...source("trade"), sid, seq: 1 }));
      peer.socket.send(JSON.stringify({ id: command.id, type: "subscribed", msg: { channel: "trade", sid } })); return true;
    } return false;
  });
  await client.connect(); const handle = await client.subscribe("trade");
  assert.equal((await handle.messages().next()).value.type, "trade");
  const internal = internalHandle(handle).session;
  const oldSocket = (internal as any).socket as WebSocket;
  const before = client.generation;
  peers[0]!.socket.terminate(); await until(() => peers.length === 2 && handle.generation === client.generation);
  assert.ok(client.generation > before);
  oldSocket.emit("message", Buffer.from(JSON.stringify({ type: "error", id: 100, msg: { code: 7, msg: "stale" } })), false);
  oldSocket.emit("ping", Buffer.from("heartbeat"));
  assert.equal((await handle.messages().next()).value.type, "trade");
  assert.deepEqual((await client.listSubscriptions()).msg, [{ channel: "trade", sid: 101 }]);
});

test("stale cleanup cannot erase a reused SID's current owner and gap continuity", {timeout:5000}, async t=>{
  const {client,peers,commands,send}=await harness(t);await client.connect();
  const previous=await client.subscribe("trade"),oldOwner=internalHandle(previous);await previous.unsubscribe();
  const current=await client.subscribe("orderbook_delta",{market_tickers:[ticker]});assert.equal(current.sid,previous.sid);
  await until(()=>current.book(ticker)?.ready===true);
  oldOwner.session.remove(oldOwner);
  send(peers[0]!,"orderbookDelta",current.sid,{seq:current.book(ticker)!.sequence+2,msg:{...source("orderbookDelta").msg,market_ticker:ticker,price_dollars:"0.1",delta_fp:"1",side:"yes"}});
  await until(()=>commands.some(c=>c.params?.action==="get_snapshot"));
  await until(()=>current.book(ticker)?.ready===true);assert.deepEqual(current.book(ticker)?.yes,[]);
});

test("unsubscribe intent during a disconnect cannot be resurrected by resubscription", async t => {
  let held = false;
  const { client, peers, commands } = await harness(t, {}, (_peer, command) => {
    if (command.cmd === "update_subscription") { held = true; return true; } return false;
  });
  await client.connect(); const handle = await client.subscribe("ticker", { market_tickers: [ticker] });
  const update = handle.update({ action: "add_markets", market_tickers: [ticker2] });
  const rejected = assert.rejects(update, /disconnect/); await until(() => held);
  const removed = handle.unsubscribe(); peers[0]!.socket.terminate();
  await rejected; await removed; await until(() => peers.length === 2);
  assert.equal(commands.filter(c => c.cmd === "subscribe").length, 1);
});

test("all-provider and all-market subscriptions replay acknowledged removals in wire order, not guessed finite filters", {timeout:5000}, async t=>{
  const {client,peers,commands}=await harness(t);
  await client.connect();
  const cf=await client.subscribe("cfbenchmarks_value",{index_ids:["all"]});
  const fills=await client.subscribe("fill");
  await cf.unsubscribeIndices(["BRTI"]);await cf.subscribeIndices(["ETHUSD_RTI"]);
  await fills.update({action:"delete_markets",market_tickers:[ticker]});
  const offset=commands.length;peers[0]!.socket.terminate();
  await until(()=>peers.length===2&&client.state==="open");
  const replay=commands.slice(offset);
  assert.deepEqual(replay.map(c=>[c.cmd,c.params.action??c.params.channels[0]]),[
    ["subscribe","cfbenchmarks_value"],["update_subscription","unsubscribe_indices"],
    ["update_subscription","subscribe_indices"],["subscribe","fill"],["update_subscription","delete_markets"]
  ]);
  assert.deepEqual(replay[0]!.params.index_ids,["all"]);assert.equal(replay[3]!.params.market_tickers,undefined);
  assert.deepEqual(replay[4]!.params.market_tickers,[ticker]);
  assert.equal(cf.generation,client.generation);assert.equal(fills.generation,client.generation);
});

test("later all/empty filter transitions restore through source-valid subscribe plus acknowledged mutation replay", {timeout:5000}, async t=>{
  const {client,peers,commands}=await harness(t);
  await client.connect();
  const cf=await client.subscribe("cfbenchmarks_value",{index_ids:["BRTI"]});
  const book=await client.subscribe("orderbook_delta",{market_tickers:[ticker]});
  await until(()=>book.book(ticker)?.ready===true);
  await cf.subscribeIndices(["all"]);await cf.unsubscribeIndices(["BRTI"]);
  await book.update({action:"delete_markets",market_tickers:[ticker]});assert.equal(book.book(ticker),undefined);
  const offset=commands.length;peers[0]!.socket.terminate();
  await until(()=>peers.length===2&&client.state==="open");
  const replay=commands.slice(offset);
  assert.deepEqual(replay.map(c=>c.params.action??c.params.channels[0]),[
    "cfbenchmarks_value","subscribe_indices","unsubscribe_indices","orderbook_delta","delete_markets"
  ]);
  assert.deepEqual(replay[0]!.params.index_ids,["BRTI"]);assert.deepEqual(replay[3]!.params.market_tickers,[ticker]);
  assert.equal(book.book(ticker),undefined);
});

test("a second sequence gap during multi-market snapshot recovery fences the old generation", {timeout:5000}, async t=>{
  let requested:Schema|undefined;
  const {client,peers,send}=await harness(t,{},(_peer,command)=>{
    if(command.params?.action==="get_snapshot"){requested=command;return true;}return false;
  });
  await client.connect();const handle=await client.subscribe("orderbook_delta",{market_tickers:[ticker,ticker2]});
  await until(()=>handle.book(ticker2)?.ready===true);
  const generation=client.generation;const sid=handle.sid;
  send(peers[0]!,"orderbookDelta",sid,{seq:4,msg:{...source("orderbookDelta").msg,market_ticker:ticker,price_dollars:"0.1",delta_fp:"1",side:"yes"}});
  await until(()=>requested!==undefined);
  send(peers[0]!,"orderbookSnapshot",sid,{id:requested!.id,seq:6,msg:{...source("orderbookSnapshot").msg,market_ticker:ticker}});
  await until(()=>client.generation>generation);
  await until(()=>peers.length===2&&client.state==="open"&&handle.book(ticker2)?.ready===true);
  assert.notEqual(handle.sid,sid);assert.equal(handle.book(ticker)?.generation,client.generation);
});

test("close on a reconnect acknowledgement cannot let stale restoration announce open", {timeout:5000}, async t=>{
  const {client,peers}=await harness(t);await client.connect();await client.subscribe("trade");
  const generation=client.generation,states:string[]=[];
  const watching=(async()=>{
    let closing=false;
    for await (const event of client.events()) {
      if (event.generation<=generation) continue;
      if (event.kind==="message"&&"type" in event.value&&event.value.type==="subscribed") {closing=true;void client.close();}
      if (closing&&event.kind==="state") states.push(event.value);
    }
  })();
  peers[0]!.socket.terminate();await watching;
  assert.equal(client.state,"closed");assert.equal(states.includes("open"),false);assert.equal(peers.length,2);
});

test("heartbeat failures exhaust a bounded reconnect budget and close all waiters", { timeout: 5000 }, async t => {
  const { client, peers } = await harness(t, { heartbeatTimeoutMs: 1000, reconnect: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
  await client.connect(); const handle = await client.subscribe("trade");
  assert.equal(client.state, "open");
  const waiter = handle.messages().next(); const rejected = assert.rejects(waiter, /exhausted/);
  await until(() => client.state === "closed"); await rejected; assert.equal(peers.length, 2);
});

test("upgrade redirects are refused without forwarding credentials and handshake deadline is bounded", async t => {
  let upgrades = 0;
  const server = createServer();
  server.on("upgrade", (_request, socket) => { upgrades++; socket.end("HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:1/other\r\nContent-Length: 0\r\n\r\n"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const client = new KalshiPredictionsWebSocketClient({ auth: { apiKeyId: "x", privateKeyPem: keys.privateKey }, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/trade-api/ws/v2`, reconnect: { maxAttempts: 0 } });
  t.after(async () => { await client.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await assert.rejects(client.connect({ timeoutMs: 100 }), /302|closed|timed out/); assert.equal(upgrades, 1);
});

test("a stalled upgrade honors handshake deadlines and close cancels it without reconnect", {timeout:5000}, async t=>{
  let upgrades=0;
  const server=createServer();const sockets=new Set<import("node:stream").Duplex>();
  server.on("upgrade",(_request,socket)=>{upgrades++;sockets.add(socket);socket.on("close",()=>sockets.delete(socket));});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const options={auth:{apiKeyId:"x",privateKeyPem:keys.privateKey},url:`ws://127.0.0.1:${(server.address() as AddressInfo).port}/trade-api/ws/v2`,closeTimeoutMs:20,reconnect:{maxAttempts:2,baseDelayMs:1}};
  const client=new KalshiPredictionsWebSocketClient(options),closingClient=new KalshiPredictionsWebSocketClient(options);
  t.after(async()=>{await client.close();await closingClient.close();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  await assert.rejects(client.connect({timeoutMs:20}),KalshiTimeoutError);assert.equal(client.state,"idle");
  const connecting=closingClient.connect({timeoutMs:1000});const rejected=assert.rejects(connecting);
  await until(()=>upgrades===2);await closingClient.close();await rejected;
  await tick();assert.equal(closingClient.state,"closed");assert.equal(upgrades,2);
});

test("bulk unsubscribe is a single multi-SID wire command after earlier per-handle mutations", async t => {
  const { client, commands } = await harness(t);
  await client.connect();
  const a = await client.subscribe("ticker", { market_tickers: [ticker] });
  const b = await client.subscribe("fill", { market_tickers: [ticker] });
  const first = a.update({ action: "add_markets", market_tickers: [ticker2] });
  const closed = client.unsubscribe([a, b], { id: 321 });
  await first; assert.equal((await closed).length, 2);
  const wire = commands.find(c => c.id === 321)!; assert.equal(wire.cmd, "unsubscribe"); assert.deepEqual(wire.params.sids, [a.sid, b.sid]);
  assert.equal(commands.indexOf(wire) > commands.findIndex(c => c.params?.action === "add_markets"), true);
  assert.deepEqual((await client.listSubscriptions()).msg, []);
});

test("canceled unsubscribe removes remote subscriptions through a fenced session, never leaving inaccessible SIDs", async t => {
  const { client, peers } = await harness(t);
  await client.connect(); const handle = await client.subscribe("trade");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(handle.unsubscribe({ signal: controller.signal }), /cancel/);
  await until(() => peers.length === 2 && client.state === "open");
  assert.deepEqual((await client.listSubscriptions()).msg, []);
});

test("Perps covers all 8 channels, 22 operations/bindings/components and 27 source schemas without Predictions fields", () => {
  assert.deepEqual(perpsData.counts, { channels:8, operations:22, bindings:22, components:22, schemas:27 });
  const perps = perpsWsContract as unknown as StreamingContract;
  const validator = new StreamingValidator(perps);
  for (const fixture of perpsData.fixtures) { validator.validate(fixture.name,fixture.payload); assert.throws(()=>validator.validate(fixture.name,true),KalshiContractError); }
  for (const fixture of perpsData.schemas) { validator.validateSchema(fixture.name,fixture.value); assert.throws(()=>validator.validateSchema(fixture.name,typeof fixture.value === "string" ? 42 : typeof fixture.value === "number" ? {} : 42),KalshiContractError); }
  assert.equal(Object.keys(perps.channels).length,8);
  assert.equal(perps.components.schemas.marginOrderbookDeltaPayload!.properties.msg.properties.price_dollars,undefined);
});

for (const channel of Object.keys(perpsWsContract.channels).filter(c=>!["root","control_frames"].includes(c))) {
  test(`Perps ${channel}: separate real transport, every source model, commands, metadata and root/control frames`, {timeout:5000}, async t=>{
    const {client,peers,send}=await harness(t,{},undefined,"perps");
    await client.connect(); await client.ping();
    let pongs=0;peers[0]!.socket.on("pong",bytes=>{assert.equal(bytes.toString(),"heartbeat");pongs++;});
    peers[0]!.socket.ping("heartbeat");await until(()=>pongs===1);
    const handle=await (client.subscribe as any)(channel,channel==="orderbook_delta"?{market_tickers:[ticker]}:{});
    if(channel==="orderbook_delta")await handle.messages().next();
    for(const component of (perpsWsContract.channels as Record<string,readonly string[]>)[channel]!) {
      const message=source(component,"perps");delete message.seq;
      if(message.msg?.market_ticker)message.msg.market_ticker=ticker;
      if(component==="orderbookDelta")Object.assign(message.msg,{price:"123.4500",delta:"0.20",side:"bid"});
      const expected=send(peers[0]!,component,handle.sid,message);assert.deepEqual((await handle.messages().next()).value,expected);
    }
    if(["orderbook_delta","ticker","fill","user_orders"].includes(channel)) {
      await handle.update({action:"add_markets",market_tickers:[ticker2]});await handle.update({action:"delete_markets",market_tickers:[ticker2]});
    }
    if(channel==="orderbook_delta")assert.equal((await handle.getSnapshot([ticker])).length,1);
    assert.deepEqual((await client.listSubscriptions()).msg,[{channel,sid:handle.sid}]);
    await client.unsubscribe([handle]);assert.deepEqual((await client.listSubscriptions()).msg,[]);
  });
}

test("Perps decimal book, multi-market gap recovery, empty-side reset and reconnect use only bid/ask/price/delta wire fields", {timeout:5000}, async t=>{
  let requested:Schema|undefined;
  const {client,peers,send}=await harness(t,{},(_peer,command)=>{
    if(command.params?.action==="get_snapshot"){requested=command;return true;}return false;
  },"perps");
  await client.connect();const handle=await client.subscribe("orderbook_delta",{market_tickers:[ticker,ticker2]});
  await handle.messages().next();await handle.messages().next();assert.deepEqual(handle.book(ticker)?.bid,[["123.45","0.1"]]);
  const delta={...source("orderbookDelta","perps").msg,market_ticker:ticker,price:"123.4500",delta:"0.20",side:"bid"};
  send(peers[0]!,"orderbookDelta",handle.sid,{msg:delta});await handle.messages().next();assert.deepEqual(handle.book(ticker)?.bid,[["123.45","0.3"]]);
  const last=peers[0]!.sequence.get(handle.sid)!;send(peers[0]!,"orderbookDelta",handle.sid,{seq:last+2,msg:delta});
  await until(()=>requested!==undefined);assert.equal(handle.book(ticker)?.ready,false);assert.equal(handle.book(ticker2)?.ready,false);
  for(const market of [ticker,ticker2])send(peers[0]!,"orderbookSnapshot",handle.sid,{id:requested!.id,msg:{market_ticker:market}});
  await until(()=>handle.book(ticker2)?.ready===true);assert.deepEqual(handle.book(ticker)?.bid,[]);assert.deepEqual(handle.book(ticker)?.ask,[]);
  const generation=client.generation;const oldSid=handle.sid;peers[0]!.socket.terminate();
  await until(()=>peers.length===2&&handle.generation===client.generation&&client.state==="open");
  await until(()=>handle.book(ticker2)?.ready===true);assert.ok(client.generation>generation);assert.notEqual(handle.sid,oldSid);
  assert.deepEqual(handle.book(ticker)?.bid,[["123.45","0.1"]]);assert.equal(handle.book(ticker)?.priceConvention,"bid-ask");
});
