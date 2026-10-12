import assert from "node:assert/strict";
import { constants, generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { KalshiClient } from "../src/index.js";
import type { TypedOperationId } from "../src/index.js";
import { operationContracts } from "../src/generated/contracts.js";

interface Fixture {
  operationId: TypedOperationId;
  methodName: string;
  input: {pathParameters?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown};
  responses: {status: number; body?: unknown}[];
}

test("all named REST methods serialize and sign through real HTTP transport", {timeout: 20000}, async t => {
  const fixtures = JSON.parse(readFileSync("test/typed-fixtures.json", "utf8")).fixtures as Fixture[];
  const {privateKey, publicKey} = generateKeyPairSync("rsa", {modulusLength: 2048});
  const timestamp = "1790000000000";
  let index = 0;
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      const fixture = fixtures[index++]!;
      const contract = operationContracts[fixture.operationId]!;
      const url = new URL(request.url!, "http://localhost");
      assert.equal(request.method, contract.method);
      assert.equal(url.pathname, `/trade-api/v2${contract.path.replace(/\{([^}]+)}/g, (_, name: string) => encodeURIComponent(String(fixture.input.pathParameters![name])))}`);
      for (const parameter of contract.parameters.filter(p => p.in === "query")) {
        const value = fixture.input.query![parameter.name];
        const expected = Array.isArray(value) ? (parameter.explode ?? true) ? value.map(String) : [value.join(",")] : [String(value)];
        assert.deepEqual(url.searchParams.getAll(parameter.name), expected);
      }
      assert.equal(request.headers["kalshi-access-key"], "wire-test");
      assert.equal(request.headers["kalshi-access-timestamp"], timestamp);
      assert.equal(verify("sha256", Buffer.from(`${timestamp}${request.method}${url.pathname}`), {
        key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST
      }, Buffer.from(String(request.headers["kalshi-access-signature"]), "base64")), true);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      assert.equal(Buffer.concat(chunks).toString(), fixture.input.body === undefined ? "" : JSON.stringify(fixture.input.body));
      const success = fixture.responses.find(r => r.status >= 200 && r.status < 300)!;
      response.writeHead(success.status, {"content-type": "application/json"});
      response.end(success.body === undefined ? undefined : JSON.stringify(success.body));
    } catch (error) {
      failures.push(error);
      response.writeHead(500);
      response.end();
    }
  });
  server.requestTimeout = 5000;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  const client = new KalshiClient({
    environment: {name: "loopback", restBaseUrl: `http://127.0.0.1:${port}/trade-api/v2`, websocketUrl: `ws://127.0.0.1:${port}`},
    auth: {apiKeyId: "wire-test", privateKeyPem: privateKey, timestampProvider: () => timestamp}
  });
  for (const fixture of fixtures) {
    const method = (client as unknown as Record<string, (input: unknown) => Promise<unknown>>)[fixture.methodName]!;
    const body = await method.call(client, fixture.input);
    assert.deepEqual(body, fixture.responses.find(r => r.status >= 200 && r.status < 300)!.body);
  }
  assert.equal(index, 118);
  assert.deepEqual(failures, []);
});
