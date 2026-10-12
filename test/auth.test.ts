import assert from "node:assert/strict";
import { constants, createHash, createPrivateKey, createSecretKey, generateKeyPairSync, type KeyObject, verify } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import test from "node:test";
import { KalshiAuthError, KalshiClient, signKalshiRequest, type KalshiAuthOptions } from "../src/index.js";

const rsa = generateKeyPairSync("rsa", {modulusLength: 2048});
const ed = generateKeyPairSync("ed25519");
const timestamp = "1790000000000";
const plain = "1790000000000GET/trade-api/v2/portfolio/balance";
const encrypted = rsa.privateKey.export({type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "synthetic-test-password"});
const cases: {name: string; key: KalshiAuthOptions["privateKeyPem"]; publicKey: KeyObject}[] = [
  {name: "RSA PKCS1 string", key: rsa.privateKey.export({type: "pkcs1", format: "pem"}), publicKey: rsa.publicKey},
  {name: "RSA PKCS8 string", key: rsa.privateKey.export({type: "pkcs8", format: "pem"}), publicKey: rsa.publicKey},
  {name: "RSA PKCS1 Buffer", key: Buffer.from(rsa.privateKey.export({type: "pkcs1", format: "pem"})), publicKey: rsa.publicKey},
  {name: "RSA private KeyObject", key: rsa.privateKey, publicKey: rsa.publicKey},
  {name: "decrypted RSA KeyObject", key: createPrivateKey({key: encrypted, passphrase: "synthetic-test-password"}), publicKey: rsa.publicKey},
  {name: "Ed25519 PKCS8 string", key: ed.privateKey.export({type: "pkcs8", format: "pem"}), publicKey: ed.publicKey},
  {name: "Ed25519 PKCS8 Buffer", key: Buffer.from(ed.privateKey.export({type: "pkcs8", format: "pem"})), publicKey: ed.publicKey},
  {name: "Ed25519 private KeyObject", key: ed.privateKey, publicKey: ed.publicKey}
];
function check(publicKey: KeyObject, message: string | Buffer, signature: Buffer): boolean {
  const bytes = typeof message === "string" ? Buffer.from(message) : message;
  return publicKey.asymmetricKeyType === "ed25519" ? verify(null, bytes, publicKey, signature)
    : verify("sha256", bytes, {key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST}, signature);
}

for (const fixture of cases) {
  test(`${fixture.name}: independent signatures and canonicalization negatives`, () => {
    const auth = {apiKeyId: "fixture-key", privateKeyPem: fixture.key, timestampProvider: () => timestamp};
    const first = signKalshiRequest(auth, "get", "/trade-api/v2/portfolio/balance?subaccount=1");
    const signature = Buffer.from(first.signature, "base64");
    assert.equal(check(fixture.publicKey, plain, signature), true);
    for (const wrong of [plain.replace(timestamp, "1790000000001"), plain.replace("GET", "POST"), plain.replace("balance", "fills"), `${plain}?subaccount=1`]) assert.equal(check(fixture.publicKey, wrong, signature), false);
    const second = signKalshiRequest(auth, "GET", "/trade-api/v2/portfolio/balance?subaccount=2");
    assert.equal(check(fixture.publicKey, plain, Buffer.from(second.signature, "base64")), true);
    assert.equal(first.timestampMs, timestamp);
    assert.deepEqual(Object.keys(first.headers).sort(), ["KALSHI-ACCESS-KEY", "KALSHI-ACCESS-SIGNATURE", "KALSHI-ACCESS-TIMESTAMP"]);
    if (fixture.publicKey.asymmetricKeyType === "ed25519") {
      assert.equal(signature.byteLength, 64);
      assert.equal(first.signature, second.signature);
      assert.equal(check(fixture.publicKey, createHash("sha256").update(plain).digest(), signature), false);
      assert.equal(check(generateKeyPairSync("ed25519").publicKey, plain, signature), false);
    } else assert.equal(check(generateKeyPairSync("rsa", {modulusLength: 2048}).publicKey, plain, signature), false);
    const websocket = signKalshiRequest(auth, "GET", "/trade-api/ws/v2?ignored=true");
    assert.equal(check(fixture.publicKey, `${timestamp}GET/trade-api/ws/v2`, Buffer.from(websocket.signature, "base64")), true);
  });
}

test("malformed, encrypted, unsupported and nonprivate keys fail without dispatch or secrets", async () => {
  const secret = "SECRET_SIGNING_MATERIAL";
  const ec = generateKeyPairSync("ec", {namedCurve: "prime256v1"});
  const pss = generateKeyPairSync("rsa-pss", {modulusLength: 2048});
  const invalid = [secret, Buffer.from(secret), encrypted, Buffer.from(encrypted), rsa.publicKey, ed.publicKey,
    createSecretKey(Buffer.from(secret)), ec.privateKey, pss.privateKey];
  for (const key of invalid) {
    let calls = 0;
    const client = new KalshiClient({auth: {apiKeyId: "fixture-key", privateKeyPem: key}, retry: {maxAttempts: 3}, fetch: async () => {calls++; throw new Error("must not dispatch");}});
    await assert.rejects(client.getExchangeStatus(), error => {
      assert.ok(error instanceof KalshiAuthError);
      assert.equal(error.cause, undefined);
      for (const output of [String(error.stack), inspect(error, {depth: 10}), JSON.stringify(error)]) {
        assert.ok(!output.includes(secret));
        assert.ok(!output.includes("BEGIN"));
      }
      return true;
    });
    assert.equal(calls, 0);
  }
  for (const overrides of [{apiKeyId: `${secret}\n`}, {timestampProvider: () => `${secret}\n`},
    {timestampProvider: () => {throw new KalshiAuthError(secret);}}]) {
    assert.throws(() => signKalshiRequest({apiKeyId: "fixture-key", privateKeyPem: rsa.privateKey, ...overrides}, "GET", "/trade-api/v2/portfolio/balance"), error => error instanceof KalshiAuthError && !String(error.stack).includes(secret) && error.cause === undefined);
  }
});

test("API key ID is captured once before callbacks or changing getters", () => {
  const auth = {
    apiKeyId: "fixture-key", privateKeyPem: rsa.privateKey,
    timestampProvider: () => { auth.apiKeyId = "SECRET\n"; return timestamp; }
  };
  assert.equal(signKalshiRequest(auth, "GET", "/trade-api/v2/exchange/status").headers["KALSHI-ACCESS-KEY"], "fixture-key");
  let reads = 0;
  const changing = {
    get apiKeyId() { return ++reads === 1 ? "fixture-key" : "SECRET\n"; },
    privateKeyPem: ed.privateKey, timestampProvider: () => timestamp
  };
  const signed = signKalshiRequest(changing, "GET", "/trade-api/v2/exchange/status");
  assert.equal(reads, 1);
  assert.equal(new Headers(signed.headers).get("KALSHI-ACCESS-KEY"), "fixture-key");
});

test("every documented key format reaches real HTTP with the correct signature", {timeout: 10000}, async t => {
  let expected: typeof cases[number];
  const failures: unknown[] = [];
  const server = createServer((request, response) => {
    try {
      assert.equal(request.url, "/trade-api/v2/exchange/status");
      assert.equal(request.headers["kalshi-access-key"], "fixture-key");
      assert.equal(request.headers["kalshi-access-timestamp"], timestamp);
      assert.equal(check(expected.publicKey, `${timestamp}GET/trade-api/v2/exchange/status`, Buffer.from(String(request.headers["kalshi-access-signature"]), "base64")), true);
      response.writeHead(200, {"content-type": "application/json"});
      response.end(JSON.stringify({exchange_active: true, trading_active: true}));
    } catch (error) {failures.push(error); response.writeHead(500); response.end();}
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));});
  const port = (server.address() as AddressInfo).port;
  for (expected of cases) {
    const client = new KalshiClient({environment: {name: "signing", restBaseUrl: `http://127.0.0.1:${port}/trade-api/v2`, websocketUrl: `ws://127.0.0.1:${port}`}, auth: {apiKeyId: "fixture-key", privateKeyPem: expected.key, timestampProvider: () => timestamp}});
    assert.deepEqual(await client.getExchangeStatus(), {exchange_active: true, trading_active: true});
  }
  assert.deepEqual(failures, []);
});
