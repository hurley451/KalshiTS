import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("installed library compiles every source-specific WS model and runs every Predictions/Perps channel through real ws", () => {
  const repository = process.cwd(), root = mkdtempSync(path.join(tmpdir(), "kalshi-streaming-consumer-"));
  const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding:"utf8", stdio:["ignore","pipe","pipe"],
    env:{...process.env,npm_config_cache:path.join(root,"npm-cache")} });
  try {
    const output = run("npm",["pack","--json","--pack-destination",root],repository);
    const pack = JSON.parse(output.slice(output.indexOf("[")))[0];
    for (const product of ["predictions","perps"]) for (const file of [`dist/src/generated/${product}-ws-client.d.ts`,`src/generated/${product}-ws-coverage.json`,`src/generated/${product}-ws-source-gaps.json`]) assert.ok(pack.files.some(f=>f.path===file),file);
    writeFileSync(path.join(root,"package.json"),JSON.stringify({private:true,type:"module"}));
    run("npm",["install","--ignore-scripts","--no-audit","--no-fund",path.join(root,pack.filename)]);
    for (const product of ["predictions","perps"]) {
      const proof = readFileSync(path.join(repository,`test/${product}-ws-types.test.ts`),"utf8").replace('"../src/index.js"','"@hurley451/kalshi-ts"');
      writeFileSync(path.join(root,`${product}.mts`),proof);
      writeFileSync(path.join(root,`${product}.json`),readFileSync(path.join(repository,`test/${product}-ws-fixtures.json`)));
      const tsc = [path.join(repository,"node_modules/typescript/lib/tsc.js"),"--strict","--noEmit","--target","ES2022","--module","NodeNext","--moduleResolution","NodeNext",
        "--typeRoots",path.join(repository,"node_modules/@types"),`${product}.mts`];
      run(process.execPath,tsc); run(process.execPath,[...tsc,"--exactOptionalPropertyTypes"]);
    }
    writeFileSync(path.join(root,"consumer.mjs"),`
import assert from "node:assert/strict";
import fs from "node:fs";
import {createServer} from "node:http";
import {once} from "node:events";
import {generateKeyPairSync,verify,constants} from "node:crypto";
import {WebSocketServer} from "ws";
import {KalshiPredictionsWebSocketClient,KalshiPerpsWebSocketClient} from "@hurley451/kalshi-ts";
let tested=0;
for(const [product,Client,count] of [["predictions",KalshiPredictionsWebSocketClient,13],["perps",KalshiPerpsWebSocketClient,6]]) {
 for(const algorithm of ["rsa","ed25519"]) {
 const keys=algorithm==="rsa"?generateKeyPairSync("rsa",{modulusLength:2048}):generateKeyPairSync("ed25519");
 const fixture=JSON.parse(fs.readFileSync(product+".json","utf8"));
 const http=createServer(),wss=new WebSocketServer({noServer:true}); let sequence=0,sid=0,latest,snapshotRequests=0,upgrades=0;const subscriptions=new Map();
 const until=async predicate=>{const end=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<end,"consumer event barrier");await new Promise(r=>setImmediate(r));}};
 const channels=fixture.fixtures.find(f=>f.name==="subscribeCommand");
 const names=product==="predictions"?["orderbook_delta","ticker","trade","fill","market_positions","market_lifecycle_v2","multivariate_market_lifecycle","communications","order_group_updates","user_orders","cfbenchmarks_value","cfbenchmarks_value_5hz","pyth_value"]:["orderbook_delta","ticker","trade","fill","user_orders","order_group_updates"];
 assert.equal(names.length,count);
 const path=product==="predictions"?"/trade-api/ws/v2":"/trade-api/ws/v2/margin";
 http.on("upgrade",(req,socket,head)=>{
  assert.equal(req.url,path);
  upgrades++;
  const key=algorithm==="rsa"?{key:keys.publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:constants.RSA_PSS_SALTLEN_DIGEST}:keys.publicKey;
  assert.equal(verify(algorithm==="rsa"?"sha256":null,Buffer.from(req.headers["kalshi-access-timestamp"]+"GET"+path),key,Buffer.from(req.headers["kalshi-access-signature"],"base64")),true);
  wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws));
 });
 wss.on("connection",ws=>{latest=ws;subscriptions.clear();ws.on("message",raw=>{
  const command=JSON.parse(raw.toString());
  if(command.cmd==="subscribe") {
   const channel=command.params.channels[0];subscriptions.set(++sid,channel); ws.send(JSON.stringify({type:"subscribed",id:command.id,msg:{channel,sid}}));
   const component=({orderbook_delta:"orderbookSnapshot",market_positions:"marketPosition",market_lifecycle_v2:"marketLifecycleV2",multivariate_market_lifecycle:"multivariateMarketLifecycle",communications:"rfqCreated",order_group_updates:"orderGroupUpdates",user_orders:"userOrder",cfbenchmarks_value:"cfbenchmarksValue",cfbenchmarks_value_5hz:"cfbenchmarksValue5Hz",pyth_value:"pythValue"})[channel]??channel;
   const body=structuredClone(fixture.fixtures.find(f=>f.name===component).payload); body.sid=sid;
   if("seq" in body) body.seq=++sequence;
   if(body.msg?.market_ticker)body.msg.market_ticker="KXTEST-A";
   ws.send(JSON.stringify(body));
  } else if(command.cmd==="list_subscriptions") ws.send(JSON.stringify({type:"ok",id:command.id,msg:[...subscriptions].map(([sid,channel])=>({sid,channel}))}));
  else if(command.cmd==="update_subscription") {
   const target=command.params.sid??command.params.sids[0];
   if(command.params.action==="get_snapshot") {snapshotRequests++;for(const market of command.params.market_tickers) {
    const body=structuredClone(fixture.fixtures.find(f=>f.name==="orderbookSnapshot").payload);
    body.id=command.id;body.sid=target;body.seq=++sequence;body.msg.market_ticker=market;
    ws.send(JSON.stringify(body));
   }} else ws.send(JSON.stringify({type:"ok",id:command.id,sid:target,seq:++sequence,msg:{market_tickers:command.params.market_tickers}}));
  } else if(command.cmd==="unsubscribe") for(const target of command.params.sids) {
   subscriptions.delete(target);ws.send(JSON.stringify({type:"unsubscribed",id:command.id,sid:target,seq:++sequence}));
  }
 });});
 http.listen(0,"127.0.0.1");await once(http,"listening");
 const client=new Client({auth:{apiKeyId:"consumer",privateKeyPem:keys.privateKey},url:"ws://127.0.0.1:"+http.address().port+path,reconnect:{maxAttempts:2,baseDelayMs:1,maxDelayMs:2}});
 try {
  await client.connect();await client.ping();assert.equal((await client.listSubscriptions()).msg.length,0);
  for(const channel of names) {
   const params=channel==="orderbook_delta"?{market_tickers:["KXTEST-A","KXTEST-B"]}:{};
   const handle=await client.subscribe(channel,params);
   const message=(await handle.messages().next()).value; assert.ok(message.type);assert.equal(message.sid,handle.sid);
   assert.equal((await client.listSubscriptions()).msg.some(s=>s.sid===handle.sid&&s.channel===channel),true);
   if(channel==="orderbook_delta") {
    const snapshots=await handle.getSnapshot(["KXTEST-A","KXTEST-B"]);
    assert.equal(snapshots.length,2);assert.equal(handle.book("KXTEST-B").ready,true);
    await handle.update({action:"add_markets",market_tickers:["KXTEST-C"]});
   }
   await handle.unsubscribe();tested++;
  }
  assert.equal((await client.listSubscriptions()).msg.length,0);
  const book=await client.subscribe("orderbook_delta",{market_tickers:["KXTEST-A","KXTEST-B"]});
  await book.messages().next();await book.getSnapshot(["KXTEST-A","KXTEST-B"]);
  const oldGeneration=client.generation,oldSid=book.sid;latest.terminate();
  await until(()=>client.generation>oldGeneration&&client.state==="open"&&book.sid!==oldSid);
  assert.ok(upgrades>=2);await book.getSnapshot(["KXTEST-A","KXTEST-B"]);
  const before=snapshotRequests,delta=structuredClone(fixture.fixtures.find(f=>f.name==="orderbookDelta").payload);
  delta.sid=book.sid;delta.seq=sequence+=2;delta.msg.market_ticker="KXTEST-A";
  if(product==="predictions")Object.assign(delta.msg,{price_dollars:"0.10",delta_fp:"1",side:"yes"});
  else Object.assign(delta.msg,{price:"123.45",delta:"1",side:"bid"});
  latest.send(JSON.stringify(delta));
  await until(()=>snapshotRequests>before&&book.book("KXTEST-A")?.ready&&book.book("KXTEST-B")?.ready);
  await book.unsubscribe();
 }finally{await client.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>http.close(r));}
}}
assert.equal(tested,38);console.log("19 source-specific data channels with both RSA/Ed25519 plus root/control installed consumer proof passed");
`);
    assert.match(run(process.execPath,["consumer.mjs"]),/19 source-specific data channels/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
