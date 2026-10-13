import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { KalshiClient } from "../src/client.js";
import { KalshiApiError } from "../src/errors.js";
import { cfContracts } from "../src/cf-contracts.js";
import type { CfOperationId, CfQueryPairs } from "../src/generated/cf-rest/models.js";

export async function runCfConformance(coreRoot?: string): Promise<Array<{ id: string; passed: boolean; message: string }>> {
  const local = await readFile(new URL("../../test/cf-rest/fixtures.json", import.meta.url));
  if (coreRoot) assert.deepEqual(await readFile(path.join(coreRoot, "fixtures/cfbenchmarks/rest-cases.json")), local, "CF case bytes differ from generated pin");
  const fixture = JSON.parse(local.toString());
  const facts = JSON.parse(await readFile(new URL("../../src/generated/cf-rest/source-facts.json", import.meta.url), "utf8"));
  if (coreRoot) {
    assert.equal(execFileSync("git", ["-C", coreRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), facts.corePin);
    for (const [file, expected] of Object.entries(facts.inputDigests)) {
      assert.equal(createHash("sha256").update(await readFile(path.join(coreRoot, file))).digest("hex"), expected, `CF input digest mismatch: ${file}`);
    }
  }
  const coverage = JSON.parse(await readFile(new URL("../../src/generated/cf-rest/coverage.json", import.meta.url), "utf8"));
  assert.deepEqual(fixture.input.cases.map((c: any) => c.caseId), coverage.caseIds);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  let status = 200, bytes = Buffer.from('{"data":null}'), headers: Record<string, string> = { "content-type": "application/json" };
  const captured: Array<{ url: string; method: string; headers: Record<string, string | string[] | undefined>; body: Buffer }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    captured.push({ url: req.url!, method: req.method!, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(status, headers); res.end(bytes);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as { port: number };
  const environment = { name: "cf-conformance", restBaseUrl: `http://127.0.0.1:${address.port}/trade-api/v2`, websocketUrl: "ws://127.0.0.1" };
  const client = new KalshiClient({ environment, auth: { apiKeyId: "cf-test", privateKeyPem: privateKey, timestampProvider: () => "1791806400000" } });
  const results: Array<{ id: string; passed: boolean; message: string }> = [];
  try {
    for (const c of fixture.input.cases) {
      try {
        const id = c.identity.manualEntryId as CfOperationId;
        assert.equal(c.identity.sourceId, "cfbenchmarks-rest-manual");
        assert.ok(Object.hasOwn(cfContracts, id));
        const input = c.input;
        const before = captured.length;
        status = 200; bytes = Buffer.from('{"data":null}'); headers = { "content-type": "application/json" };
        switch (c.kind) {
          case "request": {
            const requestClient = input.credentialsProvided ? client : new KalshiClient({ environment });
            const options = { queryPairs: input.queryPairs as CfQueryPairs, ...(id === "cfbenchmarks.passthrough" ? { providerPath: input.providerPath } : {}) };
            if (!c.expected.valid) {
              await assert.rejects(requestClient.rawRequest(id, options));
              assert.equal(captured.length, before, "invalid input dispatched HTTP");
            } else {
              const result = await requestClient.rawRequest(id, options);
              const wire = captured.at(-1)!;
              assert.equal(captured.length, before + 1);
              assert.equal(wire.url, c.expected.request.pathAndQuery);
              assert.equal(wire.method, c.expected.request.method);
              assert.equal(wire.body.length, 0);
              assert.equal(wire.headers["kalshi-access-key"], "cf-test");
              const url = new URL(wire.url, "http://localhost");
              assert.deepEqual([...url.searchParams], c.expected.request.queryPairs);
              assert.ok(verify(null, Buffer.from(`1791806400000GET${url.pathname}`), publicKey, Buffer.from(wire.headers["kalshi-access-signature"] as string, "base64")));
              assert.deepEqual(result.rawBody, new Uint8Array(bytes));
            }
            break;
          }
          case "signing": {
            await client.cf.get(input.pathname.slice("/trade-api/v2/cfbenchmarks/".length), [...new URLSearchParams(input.query)]);
            const wire = captured.at(-1)!;
            assert.equal(wire.url.split("?", 1)[0], input.pathname);
            const signature = Buffer.from(wire.headers["kalshi-access-signature"] as string, "base64");
            assert.equal(verify(null, Buffer.from(input.candidateMessage), publicKey, signature), c.expected.valid);
            assert.ok(verify(null, Buffer.from(c.expected.signatureMessage), publicKey, signature));
            break;
          }
          case "envelope": {
            bytes = Buffer.from(JSON.stringify(input.body));
            if (c.expected.valid) {
              const result = await client.cf.historyValuesRaw();
              assert.deepEqual(result.body, c.expected.body);
              assert.deepEqual(result.rawBody, new Uint8Array(bytes));
            } else {
              await assert.rejects(client.cf.historyValuesRaw(), error => {
                assert.ok(error instanceof KalshiApiError);
                assert.equal(error.status, 200); assert.deepEqual(error.rawBody, new Uint8Array(bytes));
                return true;
              });
            }
            break;
          }
          case "error": {
            status = input.status; bytes = Buffer.from(input.rawBase64, "base64");
            headers = { ...input.headers, "content-type": input.format === "json" ? "application/json" : input.format === "binary" ? "application/octet-stream" : "text/plain" };
            await assert.rejects(client.cf.get("arbitrary/next"), error => {
              assert.ok(error instanceof KalshiApiError);
              assert.equal(error.status, c.expected.preservedResponse.status);
              assert.equal(Buffer.from(error.rawBody!).toString("base64"), c.expected.preservedResponse.rawBase64);
              for (const [key, value] of Object.entries(c.expected.preservedResponse.headers)) assert.equal(error.headers.get(key), value);
              return true;
            });
            break;
          }
          case "mapping": {
            const mapping = facts.facts.facts.errorMappings.find((m: any) => m.condition === input.condition);
            assert.equal(mapping.status === input.status && mapping.code === input.code, c.expected.valid);
            if (c.expected.valid) assert.deepEqual({ status: mapping.status, code: mapping.code, upstreamDetail: mapping.upstreamDetail === true }, c.expected.mapping);
            break;
          }
          case "metadata": {
            const contract = cfContracts[id];
            const expected = { method: contract.method, auth: contract.auth, prefix: contract.request.passthrough.prefix, rateCost: contract.rateCost };
            assert.equal(JSON.stringify(expected) === JSON.stringify(input), c.expected.valid);
            break;
          }
          default: throw new Error(`Unknown CF case kind: ${c.kind}`);
        }
        results.push({ id: c.caseId, passed: true, message: c.kind === "mapping" || c.kind === "metadata" ? "Pinned metadata obligation; not upstream wire evidence." : "Actual SDK socket/signature/raw-response obligation passed." });
      } catch (error) {
        results.push({ id: c.caseId, passed: false, message: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  return results;
}
