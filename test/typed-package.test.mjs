import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

test("packed consumers compile complete contracts and execute all named facades", () => {
  const repository = process.cwd();
  const root = mkdtempSync(path.join(tmpdir(), "kalshi-typed-consumer-"));
  const run = (command,args,cwd=root) => execFileSync(command,args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  try {
    const output = run("npm",["pack","--json","--pack-destination",root],repository);
    const pack = JSON.parse(output.slice(output.indexOf("[")))[0];
    assert.ok(pack.files.some(f=>f.path==="dist/src/generated/schema.d.ts"));
    writeFileSync(path.join(root,"package.json"),JSON.stringify({private:true,type:"module"}));
    run("npm",["install","--ignore-scripts","--no-audit","--no-fund",path.join(root,pack.filename)]);
    const proof = readFileSync(path.join(repository,"test/typed-contracts.test.ts"),"utf8").replace('"../src/index.js"','"@hurley451/kalshi-ts"');
    writeFileSync(path.join(root,"consumer.mts"),proof + `
import type { EndpointOptions, RetryPolicy, RateLimitPolicy } from "@hurley451/kalshi-ts";
function transportProof(client: KalshiClient) {
 const options: EndpointOptions = { signal: new AbortController().signal, timeoutMs: 1000 };
 const retry: RetryPolicy = { maxAttempts: 3 };
 const rate: RateLimitPolicy = { capacity: 10, refillPerSecond: 2, cost: id => id === "GetBalance" ? 2 : 1 };
 void [client.exchange.getExchangeStatus({}, options), client.portfolio.getFills({}, options), retry, rate];
}
void transportProof;
async function rawProof(client: KalshiClient) {
 const result = await client.rawRequest("GetExchangeStatus", { authenticated: false });
 const bytes: Uint8Array = result.rawBody;
 void bytes;
}
void rawProof;
`);
    run(process.execPath,[path.join(repository,"node_modules/typescript/lib/tsc.js"),"--strict","--noEmit","--target","ES2022","--module","NodeNext","--moduleResolution","NodeNext","--typeRoots",path.join(repository,"node_modules/@types"),"consumer.mts"]);
    run(process.execPath,[path.join(repository,"node_modules/typescript/lib/tsc.js"),"--strict","--exactOptionalPropertyTypes","--noEmit","--target","ES2022","--module","NodeNext","--moduleResolution","NodeNext","--typeRoots",path.join(repository,"node_modules/@types"),"consumer.mts"]);
    writeFileSync(path.join(root,"fixtures.json"),readFileSync(path.join(repository,"test/typed-fixtures.json")));
    writeFileSync(path.join(root,"consumer.mjs"),`
import assert from "node:assert/strict";
import fs from "node:fs";
import { KalshiClient, KalshiContractError, KalshiAbortError, KalshiTimeoutError } from "@hurley451/kalshi-ts";
const {fixtures} = JSON.parse(fs.readFileSync("fixtures.json","utf8"));
for (const fixture of fixtures) {
 const response = fixture.responses.find(r=>r.status<300);
 const client = new KalshiClient({fetch:async()=>response.body===undefined ? new Response(null,{status:response.status}) : Response.json(response.body,{status:response.status})});
 const domain = fixture.domain === "portfolio" ? "portfolioApi" : fixture.domain;
 assert.deepEqual(await client[domain][fixture.methodName](fixture.input,{authenticated:false}),response.body);
 await assert.rejects(client[fixture.methodName]({...fixture.input,query:{__notOfficial:true}},{authenticated:false}),KalshiContractError);
}
const controller = new AbortController();
controller.abort();
let canceledCalls = 0;
const canceled = new KalshiClient({fetch:async()=>{canceledCalls++; throw new Error("must not dispatch");}});
await assert.rejects(canceled.exchange.getExchangeStatus({}, {signal:controller.signal}), KalshiAbortError);
assert.equal(canceledCalls, 0);
const timed = new KalshiClient({timeoutMs:10, fetch:()=>new Promise(()=>{})});
await assert.rejects(timed.exchange.getExchangeStatus(), KalshiTimeoutError);
let attempts = 0;
let costs = 0;
const resilient = new KalshiClient({retry:{maxAttempts:2,baseDelayMs:0,maxDelayMs:0}, rateLimit:{capacity:2,refillPerSecond:2,cost:()=>{costs++;return 1;}}, fetch:async()=>{
 return ++attempts === 1 ? Response.json({}, {status:503}) : Response.json({exchange_active:true,trading_active:true});
}});
await resilient.exchange.getExchangeStatus();
assert.equal(attempts, 2);
assert.equal(costs, 2);
const binary = new Uint8Array([255,254,0,65]);
const rawClient = new KalshiClient({fetch:async()=>new Response(binary, {status:201})});
const raw = await rawClient.rawRequest("UpgradeAccountApiUsageLevel", {authenticated:false});
assert.deepEqual(raw.rawBody, binary);
assert.deepEqual(raw.body, binary);
assert.deepEqual(await rawClient.upgradeAccountApiUsageLevel({}, {authenticated:false}), binary);
console.log("118 packed named facade calls passed");
`);
    assert.match(run(process.execPath,["consumer.mjs"]),/118 packed/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
