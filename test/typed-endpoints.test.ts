import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { constants, generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { KalshiClient, KalshiContractError, KalshiInvalidResponseError, isEndpointError, officialOperationSource, validateContract } from "../src/index.js";
import { operationContracts, contractComponents } from "../src/generated/contracts.js";
import type { EndpointOptions, TypedOperationId } from "../src/generated/models.js";

interface Fixture { operationId: TypedOperationId; methodName: string; domain: string; input: Record<string, unknown>; responses: {status:number;body?:unknown}[] }
const data = JSON.parse(readFileSync("test/typed-fixtures.json", "utf8")) as {sha256:string;fixtures:Fixture[];schemaFixtures:{name:string;value:unknown}[]};
const named = (client: KalshiClient, fixture: Fixture) => (client as unknown as Record<string,(input:unknown, options:EndpointOptions)=>Promise<unknown>>)[fixture.methodName]!.bind(client);
test("typed fixtures cover every official operation and source digest", () => {
  assert.equal(data.sha256, officialOperationSource.sha256);
  assert.equal(data.fixtures.length, 118);
  assert.deepEqual(data.fixtures.map(f=>f.operationId).sort(), Object.keys(operationContracts).sort());
});

for (const fixture of data.fixtures) {
  test(`${fixture.operationId}: named transport, every response, invalid requests and responses`, async () => {
    const contract = operationContracts[fixture.operationId]!;
    for (const expected of fixture.responses) {
      let called = false;
      const client = new KalshiClient({ environment:"demo", fetch:async (url, init) => {
        called = true;
        const actual = new URL(url);
        assert.equal(init?.method, contract.method);
        const paths = fixture.input.pathParameters as Record<string,unknown> | undefined;
        assert.equal(actual.pathname, `/trade-api/v2${contract.path.replace(/\{([^}]+)}/g, (_,name:string)=>encodeURIComponent(String(paths![name])))}`);
        const query = fixture.input.query as Record<string,unknown> | undefined;
        for (const parameter of contract.parameters.filter(p=>p.in==="query")) {
          const value = query![parameter.name];
          if (Array.isArray(value)) assert.deepEqual(actual.searchParams.getAll(parameter.name), (parameter.explode ?? true) ? value.map(String) : [value.join(",")]);
          else assert.equal(actual.searchParams.get(parameter.name), String(value));
        }
        assert.equal(init?.body, fixture.input.body === undefined ? undefined : JSON.stringify(fixture.input.body));
        return expected.body === undefined ? new Response(null,{status:expected.status}) : Response.json(expected.body,{status:expected.status});
      }});
      if (expected.status < 300) assert.deepEqual(await named(client,fixture)(fixture.input,{authenticated:false}),expected.body);
      else await assert.rejects(named(client,fixture)(fixture.input,{authenticated:false}), error => {
        assert.ok(isEndpointError(error,fixture.operationId));
        assert.equal(error.contract.status,expected.status);
        assert.deepEqual(error.contract.body,expected.body);
        return true;
      });
      assert.ok(called);
      const domain = fixture.domain === "portfolio" ? "portfolioApi" : fixture.domain;
      assert.equal(typeof (client as unknown as Record<string,Record<string,unknown>>)[domain]![fixture.methodName],"function");
    }
    const blocked = new KalshiClient({fetch:async()=>{throw new Error("HTTP must not run");}});
    await assert.rejects(named(blocked,fixture)({...fixture.input,query:{__notOfficial:true}},{authenticated:false}),KalshiContractError);
    for (const p of contract.parameters) {
      const key = p.in === "path" ? "pathParameters" : "query";
      const input = structuredClone(fixture.input);
      (input[key] as Record<string,unknown>)[p.name] = {wrong:"type"};
      await assert.rejects(named(blocked,fixture)(input,{authenticated:false}),KalshiContractError);
      if (p.required) {
        const missing = structuredClone(fixture.input);
        delete (missing[key] as Record<string,unknown>)[p.name];
        await assert.rejects(named(blocked,fixture)(missing,{authenticated:false}),KalshiContractError);
      }
    }
    if (contract.requestBody) {
      await assert.rejects(named(blocked,fixture)({...fixture.input,body:42},{authenticated:false}),KalshiContractError);
      if (contract.requestBody.required) {
        const input = {...fixture.input}; delete input.body;
        await assert.rejects(named(blocked,fixture)(input,{authenticated:false}),KalshiContractError);
      }
    }
    for (const response of fixture.responses) {
      if (!contract.responses[String(response.status)]?.content && response.status !== 204) continue;
      const invalid = new KalshiClient({fetch:async()=>Response.json(42,{status:response.status === 204 ? 200 : response.status})});
      await assert.rejects(named(invalid,fixture)(fixture.input,{authenticated:false}), response.status >= 300 ? KalshiInvalidResponseError : KalshiContractError);
    }
  });
}

test("named public calls infer authentication from the official operation", async () => {
  const client = new KalshiClient({fetch:async()=>Response.json({exchange_active:true,trading_active:true})});
  await client.exchange.getExchangeStatus();
});

test("named endpoint signing and query explode follow the official contracts", async () => {
  const fixture = data.fixtures.find(f=>f.operationId==="GetMarketOrderbooks")!;
  const response = fixture.responses.find(r=>r.status===200)!;
  const {privateKey,publicKey} = generateKeyPairSync("rsa",{modulusLength:2048});
  const client = new KalshiClient({auth:{apiKeyId:"named",privateKeyPem:privateKey,timestampProvider:()=>"1790000000000"},fetch:async(url,init)=>{
    assert.equal(new URL(url).search,"?tickers=A%2FB&tickers=C%20D");
    const headers = new Headers(init?.headers);
    assert.equal(verify("sha256",Buffer.from("1790000000000GET/trade-api/v2/markets/orderbooks"),{key:publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:constants.RSA_PSS_SALTLEN_DIGEST},Buffer.from(headers.get("kalshi-access-signature")!,"base64")),true);
    return Response.json(response.body);
  }});
  await client.markets.getMarketOrderbooks({query:{tickers:["A/B","C D"]}});
  const blocked = new KalshiClient({fetch:async()=>{throw new Error("HTTP must not run");}});
  await assert.rejects(blocked.portfolio.getBalance(),/requires auth/);
});

test("typed boundaries reject malformed objects and preserve undeclared HTTP errors", async () => {
  const fixture = data.fixtures.find(f=>f.operationId==="GetExchangeStatus")!;
  const blocked = new KalshiClient({fetch:async()=>{throw new Error("HTTP must not run");}});
  for (const input of [null,[],{query:null},{unknown:true}]) await assert.rejects(named(blocked,fixture)(input,{authenticated:false}),KalshiContractError);
  const client = new KalshiClient({fetch:async()=>Response.json({raw:"unknown error"},{status:418})});
  await assert.rejects(client.getExchangeStatus(),error=>error instanceof Error && "status" in error && error.status===418 && !isEndpointError(error,"GetExchangeStatus"));
});

for (const fixture of data.schemaFixtures) {
  test(`component schema ${fixture.name}: official positive fixture and required/type rejection`, () => {
    const schema = { $ref:`#/components/schemas/${fixture.name}` };
    validateContract(fixture.name,"schema",schema,fixture.value);
    const component = (contractComponents.schemas as Record<string,Record<string,unknown>>)[fixture.name]!;
    const invalid = component.type === "object" || component.properties ? 42 : component.type === "array" ? {} : component.type === "integer" || component.type === "number" ? "wrong" : {};
    assert.throws(()=>validateContract(fixture.name,"schema",schema,invalid),KalshiContractError);
    for (const key of (component.required ?? []) as string[]) {
      const value = structuredClone(fixture.value) as Record<string,unknown>;
      delete value[key];
      assert.throws(()=>validateContract(fixture.name,"schema",schema,value),KalshiContractError);
    }
    for (const [key,property] of Object.entries((component.properties ?? {}) as Record<string,Record<string,unknown>>)) {
      if (property.nullable === true) validateContract(fixture.name,"schema",schema,{...(fixture.value as object),[key]:null});
    }
  });
}

test("preserves nullable, enum, unions, allOf and numeric/string/array constraints", () => {
  const cases: Array<[Record<string,unknown>,unknown,unknown]> = [
    [{type:"string",nullable:true},null,42],
    [{$ref:"#/components/schemas/FixedPointCount",nullable:true},null,42],
    [{allOf:[{type:"integer",minimum:2}],nullable:true},null,1],
    [{type:"string",enum:["yes","no"]},"yes","bid"],
    [{oneOf:[{type:"number"},{type:"integer"}]},0.5,1],
    [{anyOf:[{type:"string"},{type:"number"}]},1,false],
    [{type:"number",minimum:1,maximum:3,multipleOf:0.5},1.5,1.2],
    [{type:"number",minimum:1,exclusiveMinimum:true},2,1],
    [{type:"string",minLength:2,maxLength:3,pattern:"^[A-Z]+$"},"AB","ab"],
    [{type:"array",items:{type:"integer"},minItems:1,maxItems:2,uniqueItems:true},[1],[1,1]],
    [{type:"object",required:["x"],properties:{x:{type:"integer"}},additionalProperties:false},{x:1},{x:1,y:2}]
  ];
  for (const [index,[schema,positive,negative]] of cases.entries()) {
    validateContract("constraint-proof",String(index),schema,positive);
    assert.throws(()=>validateContract("constraint-proof",String(index),schema,negative),KalshiContractError);
  }
});

test("every official schema constraint node rejects an out-of-contract value", () => {
  const coverage = JSON.parse(readFileSync("src/generated/schema-coverage.json","utf8")) as {nodes:{pointer:string;keywords:Record<string,unknown>}[]};
  let checks = 0;
  for (const {pointer,keywords} of coverage.nodes) {
    for (const [keyword,limit] of Object.entries(keywords)) {
      let schema: Record<string,unknown> | undefined;
      let invalid: unknown;
      if (keyword === "minimum" || keyword === "maximum") {
        schema = {type:"number",[keyword]:limit};
        invalid = Number(limit) + (keyword === "minimum" ? -1 : 1);
      } else if (keyword === "minLength" || keyword === "maxLength") {
        if (keyword === "minLength" && Number(limit) === 0) continue;
        schema = {type:"string",[keyword]:limit};
        invalid = "x".repeat(keyword === "minLength" ? Number(limit)-1 : Number(limit)+1);
      } else if (keyword === "minItems" || keyword === "maxItems") {
        if (keyword === "minItems" && Number(limit) === 0) continue;
        schema = {type:"array",[keyword]:limit};
        invalid = Array.from({length:keyword === "minItems" ? Number(limit)-1 : Number(limit)+1},()=>0);
      } else if (keyword === "enum") {
        schema = {enum:limit}; invalid = "__outside_official_enum__";
      } else if (keyword === "pattern") {
        schema = {type:"string",pattern:limit}; invalid = "__outside_official_pattern__";
      }
      if (schema) {
        assert.throws(()=>validateContract("official-constraint",`${pointer}:${keyword}`,schema!,invalid),KalshiContractError);
        checks++;
      }
    }
  }
  assert.ok(checks > 100,`expected broad official constraint proof, got ${checks}`);
});
