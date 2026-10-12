import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { KalshiClient, KalshiContractError, KalshiResponseParseError, isEndpointError, validateContract } from "../src/index.js";
import type { OperationError, OperationInput, OperationResponse, TypedOperationId } from "../src/index.js";
import { operationContracts } from "../src/generated/contracts.js";

const fixtures = JSON.parse(readFileSync("test/typed-fixtures.json", "utf8")).fixtures as {operationId: TypedOperationId; methodName: string; input: Record<string, unknown>}[];

test("unspecified official bodies preserve payloads and HTTP failure metadata", async () => {
  let checked = 0;
  for (const fixture of fixtures) {
    for (const [statusText, response] of Object.entries(operationContracts[fixture.operationId]!.responses)) {
      const status = Number(statusText);
      if (response.content || status === 204) continue;
      for (const body of [{message: "upstream detail"}, "upstream text"]) {
        const client = new KalshiClient({ fetch: async () => typeof body === "string"
          ? new Response(body, {status, headers: {"retry-after": "7"}})
          : Response.json(body, {status, headers: {"retry-after": "7"}}) });
        const call = (client as unknown as Record<string, (input: unknown, options: unknown) => Promise<unknown>>)[fixture.methodName]!;
        if (status < 300) assert.deepEqual(await call.call(client, fixture.input, {authenticated: false}), body);
        else await assert.rejects(call.call(client, fixture.input, {authenticated: false}), error => {
          assert.ok(isEndpointError(error, fixture.operationId));
          assert.equal(error.status, status);
          assert.equal(error.headers.get("retry-after"), "7");
          assert.deepEqual(error.body, body);
          return true;
        });
        checked++;
      }
    }
  }
  assert.equal(checked, 232);
});

test("nullable does not override enum or const, including the historical market filter", async () => {
  const blocked = new KalshiClient({fetch: async () => {throw new Error("HTTP must not run");}});
  await assert.rejects(blocked.getHistoricalMarkets({query: {mve_filter: null} as never}), KalshiContractError);
  const schemas = [
    {type: "string", nullable: true, enum: ["exclude"]},
    {type: "string", nullable: true, const: "exclude"}
  ];
  for (const [index, schema] of schemas.entries()) {
    validateContract("nullable-restriction", String(index), schema, "exclude");
    for (const invalid of [null, "include", 1]) assert.throws(() => validateContract("nullable-restriction", String(index), schema, invalid), KalshiContractError);
  }
  validateContract("nullable-restriction", "with-null-enum", {type: "string", nullable: true, enum: ["exclude", null]}, null);
  validateContract("nullable-restriction", "with-null-const", {nullable: true, const: null}, null);
  const conflicting = {type: "string", nullable: true, enum: ["exclude"], const: "include"};
  for (const value of ["exclude", "include", null]) assert.throws(() => validateContract("nullable-restriction", "conflict", conflicting, value), KalshiContractError);
});

test("malformed success JSON never leaks response snippets or a raw parser cause", async () => {
  const secret = "SECRET_SAMPLE_PRIVATE_KEY";
  const client = new KalshiClient({fetch: async () => new Response(`{\"key\":\"${secret}\"`, {headers: {"content-type": "application/json"}})});
  await assert.rejects(client.getExchangeStatus(), error => {
    assert.ok(error instanceof KalshiResponseParseError);
    assert.equal(error.status, 200);
    assert.ok(!String(error.stack).includes(secret));
    assert.equal(error.cause, undefined);
    return true;
  });
});

function typeProof() {
  const input: OperationInput<"GetHistoricalMarkets"> = {query: {mve_filter: "exclude"}};
  // @ts-expect-error A nullable marker does not add null to an enum that excludes it.
  const invalid: OperationInput<"GetHistoricalMarkets"> = {query: {mve_filter: null}};
  const unspecified: OperationResponse<"UpdateSubaccountNetting"> = {detail: "not constrained by the source"};
  // @ts-expect-error Unspecified responses require narrowing before use.
  const invented: string = unspecified;
  const failure: OperationError<"GetFCMOrders"> = {status: 401, body: {detail: "unauthorized"}};
  const empty: OperationResponse<"CancelAllOrders"> = undefined;
  // @ts-expect-error HTTP 204 does not carry an object body.
  const notEmpty: OperationResponse<"CancelAllOrders"> = {};
  void [input, invalid, unspecified, invented, failure, empty, notEmpty];
}
void typeProof;
