import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import YAML from "yaml";
import * as sdk from "../dist/src/index.js";
import { runPerpsWireProof } from "./helpers/perps-wire.mjs";
const data=JSON.parse(fs.readFileSync("test/perps-rest/fixtures.json"));
const core=process.env.KALSHICORE_ROOT??"/private/tmp/kalshi-core-perps-pinned";
const source=YAML.parse(fs.readFileSync(`${core}/sources/perps/perps_openapi.yaml`,"utf8"));
test("51 named/domain methods, 236 bindings, RSA/Ed wire signatures, public calls, 24 no-replay mutations and 3 socket pagers",async()=>{
  assert.equal(data.fixtures.length,51);
  await runPerpsWireProof(sdk,data,source);
});
for(const f of data.fixtures) test(`${f.operationId}: input failures prevent dispatch; all declared JSON failures reject malformed bodies`,async()=>{
  let calls=0;
  const client=new sdk.KalshiPerpsClient({fetch:async()=>{calls++;return new Response(null,{status:500});}});
  const invoke=(input)=>client[f.methodName](input,{authenticated:false});
  await assert.rejects(invoke({...f.input,query:{__invalid:true}}),sdk.KalshiContractError);
  for(const p of f.parameters) {
    const location={path:"pathParameters",query:"query",header:"parameterHeaders",cookie:"cookies"}[p.in];
    const bad=structuredClone(f.input);bad[location][p.name]={wrong:"type"};
    await assert.rejects(invoke(bad),sdk.KalshiContractError);
    if(p.required) {const missing=structuredClone(f.input);delete missing[location][p.name];await assert.rejects(invoke(missing),sdk.KalshiContractError);}
  }
  if(f.requestBody) {await assert.rejects(invoke({...f.input,body:42}),sdk.KalshiContractError);if(f.requestBody.required) {const missing={...f.input};delete missing.body;await assert.rejects(invoke(missing),sdk.KalshiContractError);}}
  assert.equal(calls,0);
  for(const [status,r] of Object.entries(source.paths[f.path][f.method.toLowerCase()].responses)) {
    if(!r.content?.["application/json"]?.schema) continue;
    const invalid=new sdk.KalshiPerpsClient({fetch:async()=>Response.json(42,{status:Number(status),headers:{"X-Meta":"retained"}})});
    await assert.rejects(invalid[f.methodName](f.input,{authenticated:false}),error=>{
      assert(error instanceof (Number(status)<300?sdk.KalshiContractError:sdk.KalshiInvalidResponseError));
      if(Number(status)>=300) {assert.equal(error.status,Number(status));assert.equal(error.headers.get("x-meta"),"retained");assert.equal(Buffer.from(error.rawBody).toString(),"42");}
      return true;
    });
  }
});
test("environment roots, actual custom signed pathname, optional signing and explicit overrides",async()=>{
  for(const environment of ["production","demo"]) {
    let url;
    const client=new sdk.KalshiPerpsClient({environment,fetch:async u=>{url=String(u);return Response.json({enabled:true});}});
    await client.getMarginEnabled({}, {authenticated:false});
    const expected=source.servers[environment==="production"?0:1].url;
    assert.equal(sdk.kalshiPerpsEnvironments[environment].restBaseUrl,expected);
    assert.equal(url,expected+"/margin/enabled");
  }
  const client=new sdk.KalshiPerpsClient({fetch:async()=>{throw Error("must not dispatch");}});
  await assert.rejects(client.getMarginEnabled(),/requires auth/);
  assert.equal("getFills" in client,false);assert.equal("getMarkets" in client,false);
});
