import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import YAML from "yaml";
import { sample } from "openapi-sampler";
import { createHash } from "node:crypto";
import * as sdk from "../dist/src/index.js";
import { perpsContractComponents } from "../dist/src/generated/perps-rest/contracts.js";
import { createContractRuntime } from "../dist/src/contract-runtime.js";
import { requireCoreRoot } from "./helpers/core-root.mjs";
const core=requireCoreRoot();
const bytes=fs.readFileSync(`${core}/sources/perps/perps_openapi.yaml`);
const raw=YAML.parse(bytes.toString());
const inventory=JSON.parse(fs.readFileSync(`${core}/sources/perps/perps_openapi-inventory.json`));
const data=JSON.parse(fs.readFileSync("test/perps-rest/fixtures.json"));
const at=p=>p.slice(2).split("/").map(k=>k.replaceAll("~1","/").replaceAll("~0","~")).reduce((n,k)=>n[k],raw);
const resolve=s=>s?.$ref?resolve(at(s.$ref)):s;
test("exact source accounting and every qualified schema/ref/response identity",()=>{
 assert.equal(createHash("sha256").update(bytes).digest("hex"),data.sha256);
 assert.deepEqual(data.fixtures.map(f=>f.identity.pointer).sort(),inventory.entries.map(e=>e.identity.pointer).sort());
 assert.deepEqual(data.schemaFixtures.map(f=>f.name).sort(),Object.keys(raw.components.schemas).sort());
 assert.equal(inventory.schemas.length,213);assert.equal(inventory.references.length,457);
 assert.equal(data.fixtures.reduce((n,f)=>n+f.responses.length,0),236);
 assert.equal(new Set(data.fixtures.map(f=>f.domain)).size,11);
 for(const ref of inventory.references) {assert.equal(ref.at.sourceId,"perps_openapi");assert.equal(ref.target.sourceId,"perps_openapi");assert(at(ref.target.pointer));}
});
function negatives(schema,value,validate,prefix="") {
 const s=resolve(schema);
 if(s.required&&value&&typeof value==="object"&&!Array.isArray(value)) for(const key of s.required) {const missing=structuredClone(value);delete missing[key];assert.throws(()=>validate(missing),sdk.KalshiContractError,`${prefix}/${key} required`);}
 if(s.enum) assert.throws(()=>validate("__outside_enum__"),sdk.KalshiContractError);
 if(s.type) {
   const wrong={string:42,number:"wrong",integer:1.5,boolean:"true",object:42,array:{}}[s.type];
   assert.throws(()=>validate(wrong),sdk.KalshiContractError,`${prefix} type ${s.type}`);
 }
 if(s.format==="int32") assert.throws(()=>validate(2147483648),sdk.KalshiContractError);
 if(s.format==="int64") assert.throws(()=>validate(Number.MAX_SAFE_INTEGER+1),sdk.KalshiContractError);
 if(s.format==="uuid"||s.format==="date-time"||s.format==="date") assert.throws(()=>validate("not-a-format"),sdk.KalshiContractError);
 if(s.minimum!==undefined) assert.throws(()=>validate(s.minimum-1),sdk.KalshiContractError);
 if(s.maximum!==undefined) assert.throws(()=>validate(s.maximum+1),sdk.KalshiContractError);
 if(s.minLength>0) assert.throws(()=>validate(""),sdk.KalshiContractError);
 if(s.maxLength!==undefined) assert.throws(()=>validate("x".repeat(s.maxLength+1)),sdk.KalshiContractError);
 if(s.pattern) assert.throws(()=>validate("__outside_pattern__"),sdk.KalshiContractError);
 if(s.properties&&value&&typeof value==="object") for(const [key,p] of Object.entries(s.properties)) {
   const fixture=value[key]??sample(p,{skipNonRequired:true},raw);
   const check=v=>validate({...value,[key]:v});
   if(p.nullable===true || resolve(p).nullable===true) check(null);
   else if(resolve(p).type||resolve(p).allOf) assert.throws(()=>check(null),sdk.KalshiContractError,`${prefix}/${key} nonnullable`);
   negatives(p,fixture,check,`${prefix}/${key}`);
 }
 if(s.items&&Array.isArray(value)&&value.length) negatives(s.items,value[0],v=>validate([v]),prefix+"/items");
 if(s.additionalProperties&&typeof s.additionalProperties==="object") negatives(s.additionalProperties,sample(s.additionalProperties,{},raw),v=>validate({...value,__map:v}),prefix+"/map");
 for(const branch of s.allOf??[]) negatives(branch,value,validate,prefix+"/allOf");
}
for(const fixture of data.schemaFixtures) test(`model ${fixture.name}: raw/active positives and structural/constraint negatives`,()=>{
 const ref={$ref:`#/components/schemas/${fixture.name}`};
 sdk.validatePerpsSourceContract(fixture.name,"model",ref,fixture.sourceValue);
 sdk.validatePerpsContract(fixture.name,"model",ref,fixture.value);
 negatives(raw.components.schemas[fixture.name],fixture.sourceValue,v=>sdk.validatePerpsSourceContract(fixture.name,"model",ref,v),fixture.name);
});
for(const identity of inventory.schemas) test(`inline/root ${identity.pointer}: source-bound validation`,()=>{
 const schema=at(identity.pointer);
 const value=sample(schema,{skipNonRequired:true},raw);
 sdk.validatePerpsSourceContract(identity.pointer,"root",schema,value);
 negatives(schema,value,v=>sdk.validatePerpsSourceContract(identity.pointer,"root",schema,v),identity.pointer);
});
test("October 12 projection, exactly two nullable leverage properties and current UUID",async()=>{
 const market=data.schemaFixtures.find(f=>f.name==="MarginMarket");
 const ref={$ref:"#/components/schemas/MarginMarket"};
 const fields=["funding_deadband","funding_cap","funding_limit_unit","bid_size_fp","ask_size_fp"];
 for(const field of fields) assert.equal(Object.hasOwn(perpsContractComponents.schemas.MarginMarket.properties,field),false);
 assert(fields.every(f=>Object.hasOwn(raw.components.schemas.MarginMarket.properties,f)));
 sdk.validatePerpsContract("temporal-market","active",ref,market.value);
 assert.throws(()=>sdk.validatePerpsSourceContract("temporal-market","raw",ref,market.value),sdk.KalshiContractError);
 for(const key of ["leverage_estimate","leverage_estimates"]) {
   sdk.validatePerpsContract("temporal-market","active",ref,{...market.value,[key]:null});
   assert.throws(()=>sdk.validatePerpsSourceContract("temporal-market","raw",ref,{...market.sourceValue,[key]:null}),sdk.KalshiContractError);
 }
 for(const key of ["leverage_estimates","long_leverage_estimates","short_leverage_estimates"]) assert.throws(()=>sdk.validatePerpsContract("temporal-market","active",ref,{...market.value,[key]:{1000:null}}),sdk.KalshiContractError);
 for(const key of ["long_leverage_estimates","short_leverage_estimates"]) assert.throws(()=>sdk.validatePerpsContract("temporal-market","active",ref,{...market.value,[key]:null}),sdk.KalshiContractError);
 let calls=0;const client=new sdk.KalshiPerpsClient({fetch:async()=>{calls++;return Response.json({});}});
 const transfer=data.fixtures.find(f=>f.operationId==="IntraExchangeInstanceTransfer");
 await assert.rejects(client.intraExchangeInstanceTransfer({...transfer.input,body:{...transfer.input.body,client_transfer_id:"a"}},{authenticated:false}),/perps_openapi.*2026-10-15/);
 await assert.rejects(client.getMarginTrades({query:{ticker:"BTC"}},{authenticated:false}),sdk.KalshiContractError);
 const sub=data.fixtures.find(f=>f.operationId==="ApplyMarginSubaccountTransfer");
 sdk.validatePerpsEndpointInput(sub.operationId,sub.input);
 const missing=structuredClone(sub.input);delete missing.body.client_transfer_id;
 assert.throws(()=>sdk.validatePerpsEndpointInput(sub.operationId,missing),sdk.KalshiContractError);
 assert.equal(calls,0);
 assert(Object.values(raw.components.schemas).some(s=>s.properties?.market_version));
 assert(raw.components.schemas.AmendMarginOrderRequest.properties.expiration_time);
 assert(perpsContractComponents.schemas.MarginMarket.properties.market_version);
 assert(perpsContractComponents.schemas.CreateMarginOrderRequest.properties.market_version);
 assert(perpsContractComponents.schemas.AmendMarginOrderRequest.properties.expiration_time);
});
test("source-prose refinements allow ticker precedence and count non-null decrease values",()=>{
 const create=data.fixtures.find(f=>f.operationId==="CreateMarginOrder").input;
 const without=structuredClone(create);delete without.body.ticker;delete without.body.market_id;
 assert.throws(()=>sdk.validatePerpsEndpointInput("CreateMarginOrder",without),/ticker or market_id/);
 sdk.validatePerpsEndpointInput("CreateMarginOrder",{...create,body:{...create.body,ticker:"BTC",market_id:"00000000-0000-4000-8000-000000000000"}});
 assert.throws(()=>sdk.validatePerpsEndpointInput("CreateMarginOrder",{...create,body:{...create.body,reduce_only:true,time_in_force:"good_till_canceled"}}),/reduce_only/);
 for(const tif of ["immediate_or_cancel","fill_or_kill"]) sdk.validatePerpsEndpointInput("CreateMarginOrder",{...create,body:{...create.body,reduce_only:true,time_in_force:tif}});
 const decrease=data.fixtures.find(f=>f.operationId==="DecreaseMarginOrder").input;
 for(const body of [{reduce_by:"1.00",reduce_to:null},{reduce_to:"0.00",reduce_by:null}]) sdk.validatePerpsEndpointInput("DecreaseMarginOrder",{...decrease,body});
 for(const body of [{},{reduce_by:null,reduce_to:null},{reduce_by:"1.00",reduce_to:"1.00"}]) assert.throws(()=>sdk.validatePerpsEndpointInput("DecreaseMarginOrder",{...decrease,body}),/exactly one/);
});
test("source caches and endpoint errors remain isolated in both warming orders",()=>{
 const p=data.fixtures.find(f=>f.operationId==="IntraExchangeInstanceTransfer");
 const predictions=JSON.parse(fs.readFileSync("test/typed-fixtures.json")).fixtures.find(f=>f.operationId===p.operationId);
 for(const first of [true,false]) {
   const perps=()=>sdk.validatePerpsEndpointInput(p.operationId,p.input);
   const pred=()=>sdk.validateEndpointInput(predictions.operationId,predictions.input);
   if(first) {perps();pred();} else {pred();perps();}
   const ref={$ref:"#/components/schemas/ErrorResponse"};
   sdk.validatePerpsContract("ErrorResponse","collision",ref,{});
   sdk.validateContract("ErrorResponse","collision",ref,{});
   const a=createContractRuntime("urn:test:predictions",{schemas:{ErrorResponse:{type:"string"}}},{});
   const b=createContractRuntime("urn:test:perps",{schemas:{ErrorResponse:{type:"integer"}}},{});
   const warmA=()=>a.validateContract("IntraExchangeInstanceTransfer","body",ref,"predictions");
   const warmB=()=>b.validateContract("IntraExchangeInstanceTransfer","body",ref,1);
   if(first) {warmA();warmB();} else {warmB();warmA();}
   assert.throws(()=>a.validateContract("IntraExchangeInstanceTransfer","body",ref,1),sdk.KalshiContractError);
   assert.throws(()=>b.validateContract("IntraExchangeInstanceTransfer","body",ref,"predictions"),sdk.KalshiContractError);
 }
 const e=new sdk.KalshiPerpsEndpointError("IntraExchangeInstanceTransfer",new Response(null,{status:400}),{});
 assert.equal(sdk.isEndpointError(e,"IntraExchangeInstanceTransfer"),false);
 assert.equal(sdk.isPerpsEndpointError(e,"GetMarginFills"),false);
 assert.throws(()=>sdk.validatePerpsEndpointInput("GetFills",{}),/unknown operation/);
});
test("Perps bid/ask books reject Predictions yes/no substitutes and retain fixed-point strings beyond number precision",()=>{
 const book=data.schemaFixtures.find(f=>f.name==="MarginOrderbookCount");
 const ref={$ref:"#/components/schemas/MarginOrderbookCount"};
 sdk.validatePerpsContract("book","source",ref,book.value);
 assert.throws(()=>sdk.validatePerpsContract("book","source",ref,{yes:book.value.bids,no:book.value.asks}),sdk.KalshiContractError);
 const count={$ref:"#/components/schemas/FixedPointCount"};
 const dollars={$ref:"#/components/schemas/FixedPointDollars"};
 sdk.validatePerpsContract("precision","count",count,"9007199254740993.00");
 sdk.validatePerpsContract("precision","dollars",dollars,"9007199254740993.0000");
 assert.throws(()=>sdk.validatePerpsContract("precision","count",count,9007199254740993),sdk.KalshiContractError);
 assert.throws(()=>sdk.validatePerpsContract("precision","dollars",dollars,9007199254740993),sdk.KalshiContractError);
});
