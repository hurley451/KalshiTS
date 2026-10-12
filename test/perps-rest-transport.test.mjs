import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { generateKeyPairSync, verify } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import * as sdk from "../dist/src/index.js";
const data=JSON.parse(fs.readFileSync("test/perps-rest/fixtures.json"));
const f=data.fixtures.find(f=>f.operationId==="GetMarginExchangeStatus");
const success=f.responses.find(r=>r.status===200).body;
test("GET retry and page signatures/timestamps are regenerated on each dispatch",async()=>{
 const {privateKey,publicKey}=generateKeyPairSync("ed25519");let timestamp=1790000000000;
 const signatures=[];const times=[];let calls=0;
 const c=new sdk.KalshiPerpsClient({auth:{apiKeyId:"key",privateKeyPem:privateKey,timestampProvider:()=>String(timestamp++)},retry:{maxAttempts:3,baseDelayMs:0},fetch:async(url,init)=>{
   const headers=new Headers(init.headers);const t=headers.get("kalshi-access-timestamp");const s=headers.get("kalshi-access-signature");
   assert(verify(null,Buffer.from(t+init.method+new URL(url).pathname),publicKey,Buffer.from(s,"base64")));
   signatures.push(s);times.push(t);return ++calls<3?Response.json({}, {status:503}):Response.json(success);
 }});
 await c.getMarginExchangeStatus();assert.equal(calls,3);assert.equal(new Set(times).size,3);assert.equal(new Set(signatures).size,3);
 for(const id of ["GetMarginFills","GetMarginOrders","GetMarginTrades"]) {
   const page=data.fixtures.find(f=>f.operationId===id);let n=0;const signatures=[];
   const c=new sdk.KalshiPerpsClient({auth:{apiKeyId:"key",privateKeyPem:privateKey,timestampProvider:()=>String(timestamp++)},fetch:async(url,init)=>{
     const h=new Headers(init.headers);const s=h.get("kalshi-access-signature");signatures.push(s);
     assert(verify(null,Buffer.from(h.get("kalshi-access-timestamp")+"GET"+new URL(url).pathname),publicKey,Buffer.from(s,"base64")));
     return Response.json({...page.responses.find(r=>r.status===200).body,cursor:++n===3?"":String(n)});
   }});
   for await(const p of c[page.methodName+"Pages"]({query:{limit:1}})) void p;
   assert.equal(new Set(signatures).size,3);
 }
});
test("pre-abort, invalid signer, header isolation, safe metadata and bytes",async()=>{
 let calls=0;const fetch=async()=>{calls++;return Response.json(success);};
 const c=new sdk.KalshiPerpsClient({fetch});const control=new AbortController();control.abort();
 await assert.rejects(c.getMarginExchangeStatus({}, {signal:control.signal}));assert.equal(calls,0);
 for(const auth of [{apiKeyId:"key",privateKeyPem:"private-secret"},{apiKeyId:"key",privateKeyPem:generateKeyPairSync("ed25519").privateKey,timestampProvider:()=>{throw Error("secret callback");}}]) {
   await assert.rejects(new sdk.KalshiPerpsClient({auth,fetch}).getMarginExchangeStatus(),e=>{assert(e instanceof sdk.KalshiAuthError);assert(!String(e.stack).includes("secret"));return true;});
 }
 assert.equal(calls,0);
 const bad=new sdk.KalshiPerpsClient({fetch:async()=>new Response(Uint8Array.of(0xff,0xfe),{status:418,headers:{"content-type":"application/json","x-meta":"kept"}})});
 await assert.rejects(bad.getMarginExchangeStatus(),e=>{assert(e instanceof sdk.KalshiApiError);assert.equal(sdk.isPerpsEndpointError(e,f.operationId),false);assert.deepEqual(e.rawBody,Uint8Array.of(0xff,0xfe));return true;});
 for(const body of ["{broken",Uint8Array.of(0xff)]) {
   const c=new sdk.KalshiPerpsClient({fetch:async()=>new Response(body,{headers:{"content-type":"application/json"}})});
   await assert.rejects(c.getMarginExchangeStatus(),e=>e instanceof sdk.KalshiResponseParseError&&e.rawBody.length>0);
 }
});
test("Perps total deadline covers rate queue/backoff; Retry-After seconds/date and header isolation",async()=>{
 let calls=0;
 const c=new sdk.KalshiPerpsClient({rateLimit:{capacity:1,refillPerSecond:0.01,cost:id=>{assert.equal(id,"perps_openapi:GetMarginExchangeStatus");return 1;}},fetch:async()=>{calls++;return Response.json(success);}});
 await c.getMarginExchangeStatus();await assert.rejects(c.getMarginExchangeStatus({}, {timeoutMs:20}),sdk.KalshiTimeoutError);assert.equal(calls,1);
 for(const retryAfter of ["0",new Date(Date.now()-10000).toUTCString()]) {
   let n=0;const c=new sdk.KalshiPerpsClient({retry:{maxAttempts:2,baseDelayMs:0},fetch:async()=>++n===1?Response.json({}, {status:429,headers:{"retry-after":retryAfter}}):Response.json(success)});
   await c.getMarginExchangeStatus();assert.equal(n,2);
 }
 let n=0;const backoff=new sdk.KalshiPerpsClient({retry:{maxAttempts:3,baseDelayMs:1000,maxDelayMs:1000},fetch:async()=>{n++;return Response.json({}, {status:503});}});
 await assert.rejects(backoff.getMarginExchangeStatus({}, {timeoutMs:20}),sdk.KalshiTimeoutError);assert.equal(n,1);
 const options={headers:{"X-One":"one"}};let requests=0;
 const h=new sdk.KalshiPerpsClient({defaultHeaders:{"X-Default":"keep"},fetch:async(url,init)=>{
   const headers=new Headers(init.headers);assert.equal(headers.get("x-default"),"keep");assert.equal(headers.get("x-one"),requests++===0?"one":null);return Response.json(success);
 }});
 await h.getMarginExchangeStatus({},options);await h.getMarginExchangeStatus();assert.deepEqual(options,{headers:{"X-One":"one"}});
});
test("signed real redirects are refused without credential forwarding and custom roots sign actual paths",async()=>{
 let targetCalls=0;let sourceCalls=0;const {privateKey,publicKey}=generateKeyPairSync("ed25519");
 const target=createServer((req,res)=>{targetCalls++;res.end("{}");});target.listen(0,"127.0.0.1");await once(target,"listening");
 const source=createServer((req,res)=>{sourceCalls++;assert.equal(req.url,"/private-root/margin/exchange/status");const t=req.headers["kalshi-access-timestamp"];assert(verify(null,Buffer.from(t+"GET/private-root/margin/exchange/status"),publicKey,Buffer.from(req.headers["kalshi-access-signature"],"base64")));res.writeHead(302,{location:`http://127.0.0.1:${target.address().port}/steal`});res.end();});source.listen(0,"127.0.0.1");await once(source,"listening");
 try {
   const c=new sdk.KalshiPerpsClient({environment:{name:"custom",restBaseUrl:`http://127.0.0.1:${source.address().port}/private-root`},auth:{apiKeyId:"key",privateKeyPem:privateKey}});
   await assert.rejects(c.getMarginExchangeStatus(),sdk.KalshiTransportError);assert.equal(sourceCalls,1);assert.equal(targetCalls,0);
 } finally {source.closeAllConnections();target.closeAllConnections();await Promise.all([new Promise(r=>source.close(r)),new Promise(r=>target.close(r))]);}
});
