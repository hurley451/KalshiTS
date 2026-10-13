import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { constants, generateKeyPairSync, verify } from "node:crypto";
import { appendFile } from "node:fs/promises";

export async function withCfServer(run) {
  const state = { status: 200, bytes: Buffer.from('{"data":null,"extra":true}'), headers: { "content-type": "application/json", "x-proof": "retained" }, captures: [], handler: undefined };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const capture = { url: req.url, method: req.method, headers: req.headers, bytes: Buffer.concat(chunks) };
    state.captures.push(capture);
    if (state.handler) return state.handler(req, res);
    capture.response = { status: state.status, headers: { ...state.headers }, rawBase64: state.bytes.toString("base64") };
    res.writeHead(state.status, state.headers); res.end(state.bytes);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  state.environment = { name: "cf-wire", restBaseUrl: `http://127.0.0.1:${server.address().port}/trade-api/v2`, websocketUrl: "ws://127.0.0.1" };
  try { await run(state); }
  finally {
    server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (process.env.CF_PROOF_LOG) await appendFile(process.env.CF_PROOF_LOG, JSON.stringify({
      kind: "cf-loopback-wire", environment: state.environment, signatureProof: state.signatureProof,
      zeroDispatchProof: state.zeroDispatchProof, backoffProof: state.backoffProof, getterProof: state.getterProof, captures: state.captures
    }) + "\n");
  }
}

export function cfAuth(algorithm = "ed25519") {
  const keys = algorithm === "rsa" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ed25519");
  return { keys, auth: { apiKeyId: "cf-wire-key", privateKeyPem: keys.privateKey, timestampProvider: () => "1791806400000" } };
}

function changingPair(keys, values) {
  const reads = { key: 0, value: 0 };
  const pair = new Array(2);
  Object.defineProperty(pair, 0, { enumerable: true, get: () => keys[Math.min(reads.key++, keys.length - 1)] });
  Object.defineProperty(pair, 1, { enumerable: true, get: () => values[Math.min(reads.value++, values.length - 1)] });
  return { pair, reads };
}

export async function proveCfWire(sdk) {
  for (const algorithm of ["rsa", "ed25519"]) await withCfServer(async state => {
    const { keys, auth } = cfAuth(algorithm);
    state.signatureProof = { algorithm, publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }) };
    const client = new sdk.KalshiClient({ environment: state.environment, auth, defaultHeaders: { "x-default": "base", "x-overlap": "default" } });
    const pairs = [["id", "UNLISTED_INDEX"], ["id", "SECOND"], ["includeVerification", "true"], ["includeVerification", "false"],
      ["includeVerification", ""], ["includeVerification", "anything"], ["IncludeVerification", "false"], ["other", " +%\u96ea/&="], ["", ""]];
    const retained = pairs.filter(([key]) => key !== "includeVerification");
    const snapshot = structuredClone(pairs);
    const callOptions = { headers: { "x-call": "custom", "x-overlap": "call" } };
    const paths = [];
    const result = await client.cf.getRaw("arbitrary/\u96ea +", pairs, callOptions);
    assert.equal(result.response.status, 200); assert.equal(result.response.headers.get("x-proof"), "retained");
    assert.deepEqual(result.rawBody, new Uint8Array(state.bytes)); assert.deepEqual(result.body, { data: null, extra: true });
    paths.push("/trade-api/v2/cfbenchmarks/arbitrary/%E9%9B%AA%20%2B");
    await client.cf.values(pairs); paths.push("/trade-api/v2/cfbenchmarks/values");
    await client.cf.historyValues(pairs); paths.push("/trade-api/v2/cfbenchmarks/history/values");
    await client.request("cfbenchmarks.passthrough", { providerPath: "arbitrary/\u96ea +", queryPairs: pairs }); paths.push(paths[0]);
    await client.rawRequest("cfbenchmarks.values", { queryPairs: pairs }); paths.push(paths[1]);
    await client.rawRequest("cfbenchmarks.history-values", { queryPairs: pairs }); paths.push(paths[2]);
    assert.deepEqual(pairs, snapshot);
    for (const [index, capture] of state.captures.entries()) {
      const url = new URL(capture.url, state.environment.restBaseUrl);
      assert.equal(url.pathname, paths[index]); assert.deepEqual([...url.searchParams], retained);
      assert.equal(capture.method, "GET"); assert.equal(capture.bytes.length, 0);
      assert.equal(capture.headers.accept, "application/json"); assert.equal(capture.headers["kalshi-access-key"], auth.apiKeyId);
      assert.equal(capture.headers["x-default"], "base");
      const key = algorithm === "rsa" ? { key: keys.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : keys.publicKey;
      const signature = Buffer.from(capture.headers["kalshi-access-signature"], "base64");
      const verifyMessage = message => verify(algorithm === "rsa" ? "sha256" : null, Buffer.from(message), key, signature);
      assert.equal(verifyMessage(`1791806400000GET${url.pathname}`), true);
      for (const wrong of [`1791806400000GET${url.pathname}${url.search}`, `1791806400000POST${url.pathname}`, "1791806400000GET/wrong"]) assert.equal(verifyMessage(wrong), false);
    }
    assert.equal(state.captures[0].headers["x-call"], "custom"); assert.equal(state.captures[0].headers["x-overlap"], "call");
    await client.cf.values({ id: "X", maxResolution: "1m", future: "open", absent: undefined });
    assert.equal(state.captures.at(-1).url, "/trade-api/v2/cfbenchmarks/values?id=X&maxResolution=1m&future=open");
    await client.cf.historyValues({ id: "X", timespan: "1h", timestamp: "opaque", maxResolution: "1m" });
    assert.equal(state.captures.at(-1).url, "/trade-api/v2/cfbenchmarks/history/values?id=X&timespan=1h&timestamp=opaque&maxResolution=1m");
    await client.cf.get("history/values"); assert.equal(state.captures.at(-1).url, "/trade-api/v2/cfbenchmarks/history/values");
    const customRoot = { ...state.environment, restBaseUrl: state.environment.restBaseUrl.replace("/trade-api/v2", "/proxy/v2") };
    await new sdk.KalshiClient({ environment: customRoot, auth }).cf.values();
    const capture = state.captures.at(-1);
    assert.equal(capture.url, "/proxy/v2/cfbenchmarks/values");
    const key = algorithm === "rsa" ? { key: keys.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : keys.publicKey;
    assert.equal(verify(algorithm === "rsa" ? "sha256" : null, Buffer.from("1791806400000GET/proxy/v2/cfbenchmarks/values"), key, Buffer.from(capture.headers["kalshi-access-signature"], "base64")), true);
    state.getterProof = [];
    for (const mode of ["generic", "registry", "values", "historyValues"]) {
      const probe = changingPair(["id"], ["VALID", "VALID", 123]);
      if (mode === "generic") await client.cf.get("values", [probe.pair]);
      else if (mode === "registry") await client.rawRequest("cfbenchmarks.passthrough", { providerPath: "values", queryPairs: [probe.pair] });
      else await client.cf[mode]([probe.pair]);
      assert.deepEqual(probe.reads, { key: 1, value: 1 });
      const wire = state.captures.at(-1);
      assert.equal(new URL(wire.url, state.environment.restBaseUrl).search, "?id=VALID");
      state.getterProof.push({ mode, reads: probe.reads, query: "id=VALID", unvalidatedDispatches: 0 });
    }
    const changingKey = changingPair(["id", "id", 123], ["VALID"]);
    await client.cf.get("values", [changingKey.pair]);
    assert.deepEqual(changingKey.reads, { key: 1, value: 1 });
    assert.equal(new URL(state.captures.at(-1).url, state.environment.restBaseUrl).search, "?id=VALID");
    state.getterProof.push({ mode: "changing-key", reads: changingKey.reads, query: "id=VALID", unvalidatedDispatches: 0 });
    const ignored = changingPair(["includeVerification", "id", 123], ["anything", "VALID", 123]);
    await client.cf.values([ignored.pair]);
    assert.deepEqual(ignored.reads, { key: 1, value: 1 });
    assert.equal(state.captures.at(-1).url, "/trade-api/v2/cfbenchmarks/values");
    for (const mode of ["values", "historyValues"]) {
      let reads = 0;
      const record = Object.defineProperty({}, "id", { enumerable: true, get: () => ++reads === 1 ? "VALID" : 123 });
      await client.cf[mode](record); assert.equal(reads, 1);
      assert.equal(new URL(state.captures.at(-1).url, state.environment.restBaseUrl).search, "?id=VALID");
      state.getterProof.push({ mode: `${mode}-record`, reads, query: "id=VALID", unvalidatedDispatches: 0 });
      let ignoredReads = 0;
      const ignoredRecord = Object.defineProperty({}, "includeVerification", { enumerable: true, get: () => ++ignoredReads === 1 ? "anything" : 123 });
      await client.cf[mode](ignoredRecord); assert.equal(ignoredReads, 1);
      assert.equal(new URL(state.captures.at(-1).url, state.environment.restBaseUrl).search, "");
      state.getterProof.push({ mode: `${mode}-ignored-record`, reads: ignoredReads, query: "", unvalidatedDispatches: 0 });
    }
    assert.equal(client.cf.valuesPages, undefined); assert.equal(client.cf.historyValuesPages, undefined);
  });
}

export async function proveCfNegatives(sdk) {
  await withCfServer(async state => {
    const client = new sdk.KalshiClient({ environment: state.environment, auth: cfAuth().auth });
    let rejections = 0;
    const reject = (...args) => { rejections++; return assert.rejects(...args); };
    const inheritedPair = new Array(2); Object.setPrototypeOf(inheritedPair, Object.assign(Object.create(Array.prototype), { 0: "id", 1: "X" }));
    const inheritedOuter = new Array(1); Object.setPrototypeOf(inheritedOuter, Object.assign(Object.create(Array.prototype), { 0: ["id", "X"] }));
    const badPairs = [null, {}, "id=X", [["id"]], [["id", "X", "extra"]], ["id"], [["id", 1]], [["id", null]],
      [["id",,]], [[,"X"]], [new Array(2)], new Array(1), [["id", "X"],,], [, ["id", "X"]], [inheritedPair], inheritedOuter,
      [["id", undefined]], [[undefined, "X"]], [["id", "\ud800"]], [["\udfff", "X"]], [["includeVerification", "\ud800"]], [["includeVerification",,]]];
    for (const queryPairs of badPairs) {
      await reject(client.cf.get("values", queryPairs));
      await reject(client.rawRequest("cfbenchmarks.passthrough", { providerPath: "values", queryPairs }));
    }
    const badPaths = [null, 1, "", "/values", "values/", "a//b", ".", "..", "a/../b", "a/./b", "https://provider.example/values",
      "//provider.example/values", "http:values", "a\\b", "a?x", "a#x", "%2fvalues", "%2e%2e/values", "%252e%252e/values", "a\0b", "a\nb", "a\u007fb", "a\u0085b", "\ud800"];
    for (const providerPath of badPaths) await reject(client.cf.get(providerPath));
    for (const query of [null, "string", 1, { id: 1 }, { id: null }, { id: ["X"] }, { includeVerification: false }]) {
      await reject(client.cf.values(query)); await reject(client.cf.historyValues(query));
    }
    for (const id of ["cfbenchmarks.values", "cfbenchmarks.history-values"]) {
      await reject(client.rawRequest(id, { providerPath: "values" }));
      await reject(client.request(id, { body: undefined }));
      await reject(client.request(id, { body: {} }));
      await reject(client.request(id, { query: { id: "X" } }));
      await reject(client.request(id, { pathParameters: {} }));
    }
    await reject(client.cf.values([], { body: {} }));
    await reject(new sdk.KalshiClient({ environment: state.environment }).cf.values());
    await reject(new sdk.KalshiClient({ environment: state.environment, auth: { apiKeyId: "bad", privateKeyPem: "secret-invalid" } }).cf.values(), error => error instanceof sdk.KalshiAuthError && !error.message.includes("secret-invalid"));
    for (const suffix of ["?host=provider", "#fragment"]) await reject(new sdk.KalshiClient({ environment: { ...state.environment, restBaseUrl: state.environment.restBaseUrl + suffix }, auth: cfAuth().auth }).cf.values());
    for (const [keys, values] of [[[123, "id"], ["VALID"]], [["id"], [123, "VALID"]], [["includeVerification"], [123, "VALID"]]]) {
      for (const mode of ["generic", "registry", "values", "historyValues"]) {
        const probe = changingPair(keys, values);
        if (mode === "generic") await reject(client.cf.get("values", [probe.pair]));
        else if (mode === "registry") await reject(client.rawRequest("cfbenchmarks.passthrough", { providerPath: "values", queryPairs: [probe.pair] }));
        else await reject(client.cf[mode]([probe.pair]));
        assert.deepEqual(probe.reads, { key: 1, value: 1 });
      }
    }
    for (const mode of ["values", "historyValues"]) for (const key of ["id", "includeVerification"]) {
      let reads = 0;
      const record = Object.defineProperty({}, key, { enumerable: true, get: () => ++reads === 1 ? 123 : "VALID" });
      await reject(client.cf[mode](record)); assert.equal(reads, 1);
    }
    assert.equal(state.captures.length, 0, "negative matrix must dispatch zero HTTP");
    state.zeroDispatchProof = { rejectedCases: rejections, httpDispatches: state.captures.length };
    await new sdk.KalshiClient({ environment: state.environment }).cf.values([], { authenticated: false });
    assert.equal(state.captures.length, 1); assert.equal(state.captures[0].headers["kalshi-access-key"], undefined);
  });
}

export async function proveCfErrors(sdk) {
  await withCfServer(async state => {
    const client = new sdk.KalshiClient({ environment: state.environment, auth: cfAuth().auth });
    for (const status of [400, 404, 429, 503, 401, 403, 502, 599]) for (const [format, bytes] of [
      ["application/json", Buffer.from('{"opaque":{"upstream":"detail"}}')], ["text/plain", Buffer.from("not entitled")],
      ["application/octet-stream", Buffer.from([0xff, 0, 0x81])], ["application/json", Buffer.alloc(0)], ["application/json", Buffer.from("{broken")]
    ]) {
      state.status = status; state.bytes = bytes; state.headers = { "content-type": format, "x-proof": "opaque", "retry-after": "0" };
      await assert.rejects(client.cf.valuesRaw(), error => {
        assert.ok(error instanceof sdk.KalshiApiError); assert.equal(error.status, status);
        assert.equal(error.headers.get("x-proof"), "opaque"); assert.deepEqual(error.rawBody, new Uint8Array(bytes));
        if (format === "application/json" && bytes.length && bytes.toString() !== "{broken") assert.deepEqual(error.body, JSON.parse(bytes));
        return true;
      });
    }
    state.status = 200; state.headers = { "content-type": "application/json", "x-proof": "retained" };
    for (const data of [{ unknown: "1.230000" }, [1, null], "1.234567890123456789", 1, true, null]) {
      state.bytes = Buffer.from(JSON.stringify({ data, cursor: "not-a-pager", extra: true }));
      const before = state.captures.length;
      const result = await client.cf.historyValuesRaw(); assert.deepEqual(result.body.data, data); assert.equal(result.body.cursor, "not-a-pager");
      assert.equal(state.captures.length, before + 1);
    }
    for (const body of [{}, [], null]) {
      state.bytes = Buffer.from(JSON.stringify(body));
      await assert.rejects(client.cf.valuesRaw(), error => error instanceof sdk.KalshiInvalidResponseError && error.status === 200 && Buffer.from(error.rawBody).equals(state.bytes));
    }
    for (const status of [201, 204]) {
      state.status = status; state.bytes = status === 204 ? Buffer.alloc(0) : Buffer.from('{"data":null}');
      await assert.rejects(client.cf.valuesRaw(), error => error instanceof sdk.KalshiInvalidResponseError && error.status === status);
    }
    state.status = 200;
    for (const bytes of [Buffer.from("{broken"), Buffer.from([0xff])]) {
      state.bytes = bytes;
      await assert.rejects(client.cf.valuesRaw(), error => error instanceof sdk.KalshiResponseParseError && Buffer.from(error.rawBody).equals(bytes));
    }
    state.handler = (_req, res) => { res.writeHead(200, { "content-type": "application/json", "content-length": "100" }); res.write('{"data":'); setTimeout(() => res.destroy(), 10); };
    await assert.rejects(client.cf.valuesRaw(), error => error instanceof sdk.KalshiResponseReadError && error.status === 200);
    state.handler = (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"data":'); };
    await assert.rejects(client.cf.valuesRaw([], { timeoutMs: 25 }));
    state.handler = () => {};
    await assert.rejects(client.cf.valuesRaw([], { timeoutMs: 25 }), error => error instanceof sdk.KalshiTimeoutError);
    const controller = new AbortController();
    const pending = client.cf.valuesRaw([], { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, error => error instanceof sdk.KalshiAbortError);
    await withCfServer(async upstream => {
      state.handler = (_req, res) => { res.writeHead(302, { location: upstream.environment.restBaseUrl + "/values" }); res.end(); };
      await assert.rejects(client.cf.values(), error => error instanceof sdk.KalshiTransportError);
      assert.equal(upstream.captures.length, 0, "redirect must never contact provider");
    });
  });
}

export async function proveCfOptions(sdk) {
  await withCfServer(async state => {
    const auth = cfAuth().auth;
    const low = new sdk.KalshiClient({ environment: state.environment, auth, rateLimit: { capacity: 49, refillPerSecond: 1000 } });
    await assert.rejects(low.cf.values(), RangeError); assert.equal(state.captures.length, 0);
    const limited = new sdk.KalshiClient({ environment: state.environment, auth, rateLimit: { capacity: 100, refillPerSecond: 1 } });
    await limited.cf.values(); await limited.cf.values();
    await assert.rejects(limited.cf.values([], { timeoutMs: 25 })); assert.equal(state.captures.length, 2);
    const controller = new AbortController(); const aborted = limited.cf.values([], { signal: controller.signal }); controller.abort(new Error("cancel-admission"));
    await assert.rejects(aborted, error => error instanceof sdk.KalshiAbortError); assert.equal(state.captures.length, 2);
    const ids = [];
    const callback = new sdk.KalshiClient({ environment: state.environment, auth, rateLimit: { capacity: 2, refillPerSecond: 1, cost: id => { ids.push(id); return 1; } } });
    await callback.cf.values(); await callback.cf.historyValues(); await assert.rejects(callback.cf.values([], { timeoutMs: 25 }));
    assert.deepEqual(ids.slice(0, 2), ["cfbenchmarks-rest-manual:cfbenchmarks.values", "cfbenchmarks-rest-manual:cfbenchmarks.history-values"]);
    const predictions = new sdk.KalshiClient({ environment: state.environment, auth, rateLimit: { capacity: 2, refillPerSecond: 1 } });
    await predictions.request("GetExchangeStatus"); await predictions.request("GetExchangeStatus"); await assert.rejects(predictions.request("GetExchangeStatus", { timeoutMs: 25 }));
    const queued = new sdk.KalshiClient({ environment: state.environment, auth, rateLimit: { capacity: 50, refillPerSecond: 1000 } });
    await queued.cf.values();
    const pairs = [["id", "original"]], headers = { "x-snapshot": "original" };
    const pending = queued.cf.values(pairs, { headers }); pairs[0][1] = "mutated"; headers["x-snapshot"] = "mutated";
    await pending; assert.equal(state.captures.at(-1).url, "/trade-api/v2/cfbenchmarks/values?id=original"); assert.equal(state.captures.at(-1).headers["x-snapshot"], "original");
    let attempt = 0, timestamp = 1791806400000; const costs = [];
    state.handler = (_req, res) => { attempt++; res.writeHead(attempt === 1 ? 429 : 200, { "content-type": "application/json", "retry-after": "0" }); res.end('{"data":null}'); };
    const retry = new sdk.KalshiClient({ environment: state.environment, auth: { ...auth, timestampProvider: () => timestamp++ }, retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10 }, rateLimit: { capacity: 100, refillPerSecond: 1000, cost: id => { costs.push(id); return sdk.cfOperationCost(id); } } });
    await retry.cf.get("values", [["id", "X"]]); assert.equal(attempt, 2); assert.equal(costs.length, 2);
    assert.notEqual(state.captures.at(-1).headers["kalshi-access-timestamp"], state.captures.at(-2).headers["kalshi-access-timestamp"]);
    state.backoffProof = [];
    state.handler = (_req, res) => { res.writeHead(503, { "content-type": "application/json", "retry-after": "0.5" }); res.end('{"opaque":true}'); };
    for (const mode of ["deadline", "abort"]) {
      const before = state.captures.length, admissions = [];
      let responseReadCompleted = false, signalReadComplete;
      const readComplete = new Promise(resolve => { signalReadComplete = resolve; });
      const cancel = new AbortController();
      const backoff = new sdk.KalshiClient({ environment: state.environment, auth,
        retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 1000 },
        rateLimit: { capacity: 1000, refillPerSecond: 1000, cost: id => { admissions.push(id); return sdk.cfOperationCost(id); } },
        fetch: async (...args) => {
          const response = await fetch(...args), read = response.arrayBuffer.bind(response);
          response.arrayBuffer = async () => { const bytes = await read(); responseReadCompleted = true; signalReadComplete(); return bytes; };
          return response;
        }
      });
      let settled = false;
      const result = backoff.cf.values([], mode === "deadline" ? { timeoutMs: 250 } : { signal: cancel.signal })
        .then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
      await Promise.race([readComplete, result.then(() => { throw new Error("Backoff probe settled before completed HTTP response"); })]);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(responseReadCompleted, true); assert.equal(settled, false, "must still be in permitted backoff after response read");
      assert.equal(state.captures.length - before, 1); assert.equal(admissions.length, 1);
      if (mode === "abort") cancel.abort();
      const outcome = await result;
      assert.ok(outcome.error instanceof (mode === "deadline" ? sdk.KalshiTimeoutError : sdk.KalshiAbortError));
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(state.captures.length - before, 1, "canceled backoff must not send a second attempt");
      assert.equal(admissions.length, 1, "no second-attempt admission");
      state.backoffProof.push({ mode, responseReadCompleted, httpDispatches: 1, admissions: 1, retryAfterSeconds: 0.5, maxDelayMs: 1000 });
    }
    state.handler = (_req, res) => { res.writeHead(503, { "content-type": "application/json", "retry-after": "10" }); res.end('{"opaque":true}'); };
    const beforeTerminal = state.captures.length;
    const terminal = new sdk.KalshiClient({ environment: state.environment, auth, retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10 }, rateLimit: { capacity: 1000, refillPerSecond: 1000 } });
    await assert.rejects(terminal.cf.values(), error => error instanceof sdk.KalshiApiError && error.status === 503 && error.headers.get("retry-after") === "10");
    assert.equal(state.captures.length - beforeTerminal, 1, "oversized Retry-After is terminal, not backoff");
    state.backoffProof.push({ mode: "oversized-terminal", httpDispatches: 1, retryAfterSeconds: 10, maxDelayMs: 10 });
    const noLimiter = new sdk.KalshiClient({ environment: state.environment, auth });
    state.handler = undefined;
    for (let i = 0; i < 4; i++) await noLimiter.cf.values();
    const preAborted = new AbortController(); preAborted.abort(new Error("pre-abort")); const before = state.captures.length;
    await assert.rejects(noLimiter.cf.values([], { signal: preAborted.signal }), error => error instanceof sdk.KalshiAbortError); assert.equal(state.captures.length, before);
  });
}
