import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import * as sdk from "../dist/src/index.js";
const data=JSON.parse(fs.readFileSync("test/perps-rest/fixtures.json"));
const ids=["GetMarginFills","GetMarginOrders","GetMarginTrades"];
for(const id of ids) {
 const f=data.fixtures.find(f=>f.operationId===id);
 const collection={GetMarginFills:"fills",GetMarginOrders:"orders",GetMarginTrades:"trades"}[id];
 const source=f.responses.find(r=>r.status===200).body;
 const input=structuredClone(f.input);delete input.query.cursor;
 const options={authenticated:false,headers:{"X-Pages":"keep"},timeoutMs:5000};
 const iterator=(c,i=input,p={})=>c[f.domain][f.methodName+"Pages"](i,options,p);
 test(`${id}: lazy snapshots, 0/1/N limits, early return, caller/page mutation and filters`,async()=>{
   for(const maxPages of [0,1,2,3]) {
     let calls=0;const client=new sdk.KalshiPerpsClient({fetch:async(url,init)=>{
       assert.equal(new Headers(init.headers).get("x-pages"),"keep");
       const query=new URL(url).searchParams;
       for(const [k,v] of Object.entries(input.query)) if(k!=="cursor") assert.equal(query.get(k),String(v));
       assert.equal(query.get("cursor"),calls===0?null:`p${calls}`);
       calls++;return Response.json({...source,cursor:calls===3?"":`p${calls}`});
     }});
     const before=structuredClone(input);const it=iterator(client,input,{maxPages});assert.equal(calls,0);
     const pages=[];for await(const page of it) {pages.push(page);page.cursor="consumer-mutated";page[collection]=[];}
     assert.equal(calls,maxPages);assert.equal(pages.length,maxPages);assert.deepEqual(input,before);
   }
   let calls=0;const c=new sdk.KalshiPerpsClient({fetch:async()=>{calls++;return Response.json({...source,cursor:"next"});}});
   const frozen=Object.freeze({...input,query:Object.freeze({...input.query,cursor:"initial"})});
   const it=iterator(c,frozen);await it.next();await it.return();assert.equal(calls,1);
   const mutable=structuredClone(input);const header={authenticated:false,headers:{"X-Snapshot":"before"}};
   const captured=new sdk.KalshiPerpsClient({fetch:async(url,init)=>{assert.equal(new URL(url).searchParams.get("limit"),String(input.query.limit));assert.equal(new Headers(init.headers).get("x-snapshot"),"before");return Response.json({...source,cursor:""});}});
   const snapshot=captured[f.methodName+"Pages"](mutable,header);mutable.query.limit=2;header.headers["X-Snapshot"]="after";await snapshot.next();
 });
 test(`${id}: required cursors/collections and malformed items fail; source bounds`,async()=>{
   for(const body of [{...source,cursor:null},{...source,cursor:1},{...source,[collection]:null},{...source,[collection]:[42]},(()=>{const x={...source};delete x.cursor;return x;})(),(()=>{const x={...source};delete x[collection];return x;})()]) {
     const c=new sdk.KalshiPerpsClient({fetch:async()=>Response.json(body)});
     await assert.rejects(iterator(c).next(),sdk.KalshiContractError);
   }
   const c=new sdk.KalshiPerpsClient({fetch:async()=>{throw Error("must not dispatch");}});
   for(const limit of [0,id==="GetMarginOrders"?10001:1001,"1",null]) await assert.rejects(iterator(c,{...input,query:{...input.query,limit}}).next(),sdk.KalshiContractError);
   assert.throws(()=>iterator(c,input,{maxPages:-1}),RangeError);
   assert.throws(()=>iterator(c,input,{maxPages:1.5}),RangeError);
 });
 test(`${id}: repeated cursors, A-B-A and initial-cursor cycles; later server error`,async()=>{
   for(const cursors of [["A","A"],["A","B","A"],["initial"]]) {
     let calls=0;const c=new sdk.KalshiPerpsClient({fetch:async()=>Response.json({...source,cursor:cursors[calls++]})});
     const it=iterator(c,{...input,query:{...input.query,cursor:"initial"}});
     await assert.rejects(async()=>{for await(const page of it) void page;},sdk.KalshiPaginationError);
     assert.equal(calls,cursors.length);
   }
   let calls=0;const c=new sdk.KalshiPerpsClient({fetch:async()=>++calls===1?Response.json({...source,cursor:"A"}):Response.json({message:"later failure"},{status:500})});
   const it=iterator(c);await it.next();await assert.rejects(it.next(),e=>sdk.isPerpsEndpointError(e,id)&&e.status===500);assert.equal(calls,2);
 });
 test(`${id}: real body-read abort/timeout and page signatures are fresh`,async()=>{
   const server=createServer((req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.write("{");});
   server.listen(0,"127.0.0.1");await once(server,"listening");
   try {
     const c=new sdk.KalshiPerpsClient({environment:{name:"loop",restBaseUrl:`http://127.0.0.1:${server.address().port}/trade-api/v2`}});
     await assert.rejects(c[f.methodName+"Pages"](input,{authenticated:false,timeoutMs:20}).next(),sdk.KalshiTimeoutError);
     const control=new AbortController();
     const pending=c[f.methodName+"Pages"](input,{authenticated:false,signal:control.signal}).next();
     setTimeout(()=>control.abort(),20);await assert.rejects(pending);
   } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 });
}
