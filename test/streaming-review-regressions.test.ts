import assert from "node:assert/strict";
import { constants, generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { inspect } from "node:util";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { KalshiPredictionsWebSocketClient, KalshiPerpsWebSocketClient, KalshiWebSocketBackpressureError, KalshiWebSocketCommandError, KalshiWebSocketPartialSubscriptionError } from "../src/index.js";
import { predictionsWsContract } from "../src/generated/predictions-ws-contracts.js";
import { perpsWsContract } from "../src/generated/perps-ws-contracts.js";
import { StreamingValidator, type StreamingContract, type Schema } from "../src/streaming/contracts.js";
import type { StreamingClientOptions } from "../src/streaming/session.js";

const uuid = "123e4567-e89b-12d3-a456-426614174000";
const uuid2 = "123e4567-e89b-12d3-a456-426614174001";
for(const Client of [KalshiPredictionsWebSocketClient,KalshiPerpsWebSocketClient])test(`${Client.name} inspection and JSON cannot expose private PEM/configuration`,async()=>{
  const privateKeyPem=generateKeyPairSync("ed25519").privateKey.export({type:"pkcs8",format:"pem"});
  const secret="STREAMING_PRIVATE_CONFIGURATION_SENTINEL";
  const client=new Client({auth:{apiKeyId:secret,privateKeyPem},url:`wss://example.invalid/?private=${secret}`});
  for(const output of [inspect(client,{depth:20,showHidden:true}),JSON.stringify(client)]) {
    assert.equal(output.includes(secret),false);assert.equal(output.includes("BEGIN PRIVATE KEY"),false);
  }
  assert.equal(Reflect.ownKeys(client).includes("session"),false);await client.close();
});
for(const Client of [KalshiPredictionsWebSocketClient,KalshiPerpsWebSocketClient])test(`${Client.name} invalid URL diagnostics do not expose private configuration input`,async()=>{
  const secret="STREAMING_INVALID_URL_SECRET";
  const client=new Client({auth:{apiKeyId:"review",privateKeyPem:generateKeyPairSync("ed25519").privateKey},url:secret});
  await assert.rejects(client.connect(),error=>{
    for(const output of [String(error),inspect(error,{depth:20}),JSON.stringify(error)])assert.equal(output.includes(secret),false);
    return true;
  });
  await client.close();
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test("streaming command/partial-error diagnostics redact raw response and cause while retaining explicit programmatic details",()=>{
  const secret="STREAMING_ERROR_SECRET_SENTINEL";
  const response={id:1,type:"error",msg:{code:7,msg:secret}};
  const error=new KalshiWebSocketCommandError(1,response);
  const partial=new KalshiWebSocketPartialSubscriptionError(1,["trade"],error);
  for(const value of [error,partial])for(const output of [String(value.stack),inspect(value,{depth:20}),JSON.stringify(value)])assert.equal(output.includes(secret),false);
  assert.equal(error.response,response);assert.equal(partial.cause,error);
});
async function until(predicate:()=>boolean) {
  const end=performance.now()+2000;
  while(!predicate()){assert.ok(performance.now()<end,"wire event barrier timed out");await tick();}
}
async function wire<P extends "predictions"|"perps"="predictions">(t:TestContext, handler:(socket:WebSocket, command:Schema, connection:number)=>boolean,
  options:Partial<StreamingClientOptions>={}, product:P="predictions" as P, algorithm:"rsa"|"ed25519"="rsa") {
  const keys=algorithm==="rsa"?generateKeyPairSync("rsa",{modulusLength:2048}):generateKeyPairSync("ed25519");
  const http=createServer(), wss=new WebSocketServer({noServer:true});
  const peers:WebSocket[]=[], commands:Schema[]=[], failures:unknown[]=[], stamps:string[]=[];
  const path=`/trade-api/ws/v2${product==="perps"?"/margin":""}`;
  let stamp=1790000000000,sid=0;
  http.on("upgrade",(req,socket,head)=>{
    try {
      assert.equal(req.url,path);assert.equal(req.headers["kalshi-access-key"],"review-regression");
      const timestamp=String(req.headers["kalshi-access-timestamp"]);stamps.push(timestamp);
      const key=algorithm==="ed25519"?keys.publicKey:{key:keys.publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:constants.RSA_PSS_SALTLEN_DIGEST};
      assert.equal(verify(algorithm==="ed25519"?null:"sha256",Buffer.from(timestamp+"GET"+path),key,Buffer.from(String(req.headers["kalshi-access-signature"]),"base64")),true);
      wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws));
    }catch(error){failures.push(error);socket.destroy();}
  });
  wss.on("connection",socket=>{
    peers.push(socket);const connection=peers.length;
    socket.on("error",()=>{});
    socket.on("message",raw=>{
      try {
        const command=JSON.parse(raw.toString());commands.push(command);
        if(handler(socket,command,connection))return;
        if(command.cmd==="subscribe") for(const channel of command.params.channels)socket.send(JSON.stringify({id:command.id,type:"subscribed",msg:{channel,sid:++sid}}));
        else if(command.cmd==="update_subscription")socket.send(JSON.stringify({id:command.id,type:"ok",sid:command.params.sid,msg:{}}));
        else if(command.cmd==="unsubscribe")for(const target of command.params.sids)socket.send(JSON.stringify({id:command.id,type:"unsubscribed",sid:target,seq:1}));
      }catch(error){failures.push(error);socket.terminate();}
    });
  });
  http.listen(0,"127.0.0.1");await once(http,"listening");
  const config:StreamingClientOptions={auth:{apiKeyId:"review-regression",privateKeyPem:keys.privateKey,timestampProvider:()=>String(stamp++)},
    url:`ws://127.0.0.1:${(http.address() as AddressInfo).port}${path}`,commandTimeoutMs:1000,reconnect:{maxAttempts:2,baseDelayMs:1,maxDelayMs:2},...options};
  const client=(product==="predictions"?new KalshiPredictionsWebSocketClient(config):new KalshiPerpsWebSocketClient(config)) as P extends "perps"?KalshiPerpsWebSocketClient:KalshiPredictionsWebSocketClient;
  t.after(async()=>{await client.close();for(const peer of peers)peer.terminate();await new Promise<void>(r=>wss.close(()=>r()));await new Promise<void>(r=>http.close(()=>r()));assert.deepEqual(failures,[]);});
  await client.connect();return {client,peers,commands,stamps};
}

for(const initial of ["ticker","uuid"] as const)test(`Volta mixed ${initial} selection restores exclusive subscribe and acknowledged mutation commands`,{timeout:5000},async t=>{
  const selections=new Map<number,{tickers:Set<string>;ids:Set<string>}>();
  const {client,peers,commands}=await wire(t,(socket,c,connection)=>{
    if(c.cmd==="subscribe") {
      const p=c.params;assert.ok(["market_ticker","market_tickers","market_id","market_ids"].filter(k=>p[k]!==undefined).length<=1,"restore selectors must be exclusive");
      selections.set(connection,{tickers:new Set(p.market_tickers??(p.market_ticker?[p.market_ticker]:[])),ids:new Set(p.market_ids??(p.market_id?[p.market_id]:[]))});
      socket.send(JSON.stringify({id:c.id,type:"subscribed",msg:{channel:"ticker",sid:connection}}));return true;
    }
    if(c.cmd==="update_subscription") {
      const p=c.params,state=selections.get(connection)!;const set=p.market_ids||p.market_id?state.ids:state.tickers;
      for(const v of p.market_ids??p.market_tickers??[p.market_id??p.market_ticker])p.action==="add_markets"?set.add(v):set.delete(v);
      socket.send(JSON.stringify({id:c.id,type:"ok",sid:connection,msg:{}}));return true;
    }return false;
  });
  assert.ok(client instanceof KalshiPredictionsWebSocketClient);
  const handle=await client.subscribe("ticker",initial==="ticker"?{market_tickers:["KXTEST-A"]}:{market_ids:[uuid]});
  await handle.update(initial==="ticker"?{action:"add_markets",market_ids:[uuid]}:{action:"add_markets",market_tickers:["KXTEST-A"]});
  await handle.update({action:"add_markets",market_ids:[uuid2]});await handle.update({action:"delete_markets",market_ids:[uuid]});
  const before=commands.length;peers[0]!.terminate();await until(()=>peers.length===2&&client.state==="open");
  assert.deepEqual([...selections.get(2)!.tickers],["KXTEST-A"]);assert.deepEqual([...selections.get(2)!.ids],[uuid2]);
  assert.equal(commands.slice(before).filter(c=>c.cmd==="subscribe").length,1);
});

test("mixed-selector timeout fences uncertain mutation and restores only acknowledged exclusive command history",{timeout:5000},async t=>{
  const selections=new Map<number,Set<string>>();
  const {client,peers,commands}=await wire(t,(socket,c,connection)=>{
    if(c.cmd==="subscribe") {
      assert.equal(c.params.market_ids,undefined);selections.set(connection,new Set(c.params.market_tickers));
      socket.send(JSON.stringify({id:c.id,type:"subscribed",msg:{channel:"ticker",sid:connection}}));return true;
    }
    if(c.cmd==="update_subscription") {
      for(const value of c.params.market_ids??[])selections.get(connection)!.add(value);
      if(connection===1&&c.params.market_ids?.includes(uuid2))return true;
      socket.send(JSON.stringify({id:c.id,type:"ok",sid:connection,msg:{}}));return true;
    }return false;
  });
  const handle=await client.subscribe("ticker",{market_tickers:["KXTEST-A"]});
  await handle.update({action:"add_markets",market_ids:[uuid]});
  await assert.rejects(handle.update({action:"add_markets",market_ids:[uuid2]},{timeoutMs:20}));
  await until(()=>peers.length===2&&client.state==="open");
  assert.deepEqual([...selections.get(2)!],["KXTEST-A",uuid]);
  const reconnectSubscribe=commands.findIndex(c=>c.cmd==="subscribe"&&c.id!==commands[0]!.id);
  assert.equal(commands.slice(reconnectSubscribe).some(c=>c.params?.market_ids?.includes(uuid2)),false);
});

test("Volta pending subscribe capacity reserves before ACK and releases on prewire failure and error",{timeout:5000},async t=>{
  let held:Schema|undefined;
  const {client,peers,commands}=await wire(t,(_socket,c)=>{if(c.cmd==="subscribe"){held=c;return true;}return false;},{limits:{subscriptions:1}});
  await assert.rejects(client.subscribe("trade",{}, {id:0}));
  const controller=new AbortController();controller.abort();await assert.rejects(client.subscribe("trade",{}, {signal:controller.signal}));
  const first=client.subscribe("trade");await until(()=>held!==undefined);
  await assert.rejects(client.subscribe("ticker"),KalshiWebSocketBackpressureError);assert.equal(commands.length,1);
  peers[0]!.send(JSON.stringify({id:held!.id,type:"subscribed",msg:{channel:"trade",sid:1}}));
  const handle=await first;await assert.rejects(client.subscribe("ticker"),KalshiWebSocketBackpressureError);await handle.unsubscribe();
  held=undefined;const next=client.subscribe("ticker");await until(()=>held!==undefined);
  peers[0]!.send(JSON.stringify({id:held!.id,type:"error",msg:{code:8,msg:"test rejection"}}));await assert.rejects(next);
  await until(()=>peers.length===2&&client.state==="open");
  held=undefined;const final=client.subscribe("trade");await until(()=>held!==undefined);
  peers[1]!.send(JSON.stringify({id:held!.id,type:"subscribed",msg:{channel:"trade",sid:2}}));assert.equal((await final).sid,2);
});

test("multi-channel capacity transfers on partial ACK and releases after partial failure and sent cancellation",{timeout:5000},async t=>{
  let held:Schema|undefined;
  const {client,peers}=await wire(t,(_socket,c)=>{if(c.cmd==="subscribe"){held=c;return true;}return false;},{limits:{subscriptions:2}});
  const first=client.subscribeMany({channels:["trade","ticker"]});const failed=assert.rejects(first);
  await until(()=>held!==undefined);await assert.rejects(client.subscribe("user_orders"),KalshiWebSocketBackpressureError);
  peers[0]!.send(JSON.stringify({id:held!.id,type:"subscribed",msg:{channel:"trade",sid:1}}));
  const events=client.events();for(;;){const event=await events.next();if(event.value?.kind==="message"&&"type" in event.value.value&&event.value.value.type==="subscribed")break;}
  await assert.rejects(client.subscribe("user_orders"),KalshiWebSocketBackpressureError);
  peers[0]!.send(JSON.stringify({id:held!.id,type:"error",sid:1,seq:1,msg:{code:8,msg:"partial rejection"}}));await failed;
  await until(()=>peers.length===2&&client.state==="open");held=undefined;
  const controller=new AbortController();const canceling=client.subscribeMany({channels:["trade","ticker"]},{signal:controller.signal});const canceled=assert.rejects(canceling);
  await until(()=>held!==undefined);controller.abort();await canceled;await until(()=>peers.length===3&&client.state==="open");held=undefined;
  const final=client.subscribeMany({channels:["trade","ticker"]});await until(()=>held!==undefined);
  for(const [channel,sid]of [["trade",1],["ticker",2]] as const)peers[2]!.send(JSON.stringify({id:held!.id,type:"subscribed",msg:{channel,sid}}));
  assert.equal((await final).length,2);await assert.rejects(client.subscribe("user_orders"),KalshiWebSocketBackpressureError);
});

for(const product of ["predictions","perps"] as const)test(`${product} empty-Ping rules require exact source/pointer/raw preconditions and leave other validators intact`,()=>{
  const contract=(product==="predictions"?predictionsWsContract:perpsWsContract) as unknown as StreamingContract;
  const validator=new StreamingValidator(contract);
  validator.validateControl("outgoingPing",Buffer.from(""));validator.validateControl("outgoingPing",Buffer.from("heartbeat"));
  validator.validateControl("incomingPong",Buffer.from(""),Buffer.from(""));
  assert.throws(()=>validator.validate("outgoingPing",""));assert.throws(()=>validator.validateControl("outgoingPing",Buffer.from("other")));
  assert.throws(()=>validator.validateControl("incomingPong",Buffer.from("heartbeat"),Buffer.from("")));
  assert.throws(()=>validator.validateControl("outgoingPong",Buffer.from("heartbeat")));
  for(const changed of [{...contract,sourceSnapshot:"other/asyncapi.yaml"},{...contract,compatibilityRules:[]}]) {
    const strict=new StreamingValidator(changed);assert.throws(()=>strict.validateControl("outgoingPing",Buffer.from("")));
    assert.throws(()=>strict.validateControl("incomingPong",Buffer.from("heartbeat"),Buffer.from("heartbeat")));
  }
  const changed=structuredClone(contract);changed.components.messages.outgoingPing!.payload.const="other";
  assert.throws(()=>new StreamingValidator(changed).validateControl("outgoingPing",Buffer.from("")));
});

for(const product of ["predictions","perps"] as const)test(`Volta ${product} unsafe nested SID is rejected before handle binding and in list arrays`,{timeout:5000},async t=>{
  const contract=(product==="predictions"?predictionsWsContract:perpsWsContract) as unknown as StreamingContract;
  const validator=new StreamingValidator(contract);
  assert.throws(()=>validator.validate("listSubscriptionsResponse",{type:"ok",msg:[{channel:"trade",sid:9007199254740992}]}));
  const {client}=await wire(t,(socket,c)=>{if(c.cmd!=="subscribe")return false;socket.send(`{"id":${c.id},"type":"subscribed","msg":{"channel":"trade","sid":9007199254740993}}`);return true;},{reconnect:{maxAttempts:0}},product);
  await assert.rejects(client instanceof KalshiPredictionsWebSocketClient?client.subscribe("trade"):client.subscribe("trade"));await until(()=>client.state==="closed");
});

for(const channel of ["cfbenchmarks_value","cfbenchmarks_value_5hz","pyth_value"] as const)test(`Volta ${channel} discovery cannot settle on generic OK, nor mutation on discovery data`,{timeout:5000},async t=>{
  let command:Schema|undefined;
  const {client,peers}=await wire(t,(_socket,c)=>{if(c.cmd==="update_subscription"){command=c;return true;}return false;});
  assert.ok(client instanceof KalshiPredictionsWebSocketClient);
  const handle=await client.subscribe(channel);let settled=false;
  const events=client.events();
  const discovery=channel==="pyth_value"?(handle as any).underlyingList():(handle as any).indexList();
  void discovery.then(()=>{settled=true;},()=>{settled=true;});await until(()=>command!==undefined);
  peers[0]!.send(JSON.stringify({id:command!.id,type:"ok",sid:handle.sid,seq:1,msg:{}}));
  for(;;){const event=await events.next();if(event.value?.kind==="message"&&"id" in event.value.value&&event.value.value.id===command!.id)break;}
  assert.equal(settled,false);
  const type=channel==="pyth_value"?"pyth_value_underlying_list":`${channel}_indexlist`;
  const field=channel==="pyth_value"?"underlying_tickers":"index_ids";
  const id=command!.id;peers[0]!.send(JSON.stringify({id,type,sid:handle.sid,seq:2,msg:{[field]:["SOURCE-ID"]}}));
  assert.equal((await discovery).type,type);await handle.messages().next();
  command=undefined;settled=false;
  const mutation=channel==="pyth_value"?(handle as any).subscribeUnderlyings(["SOURCE-ID"]):(handle as any).subscribeIndices(["SOURCE-ID"]);
  void mutation.then(()=>{settled=true;},()=>{settled=true;});await until(()=>command!==undefined);
  peers[0]!.send(JSON.stringify({id:command!.id,type,sid:handle.sid,seq:3,msg:{[field]:["SOURCE-ID"]}}));
  await handle.messages().next();assert.equal(settled,false);
  peers[0]!.send(JSON.stringify({id:command!.id,type:"ok",sid:handle.sid,seq:4,msg:{[field]:["SOURCE-ID"]}}));assert.equal((await mutation).type,"ok");
});

for(const product of ["predictions","perps"] as const)test(`${product} unsafe SID in a real list-subscriptions response rejects rather than exposing rounded identity`,{timeout:5000},async t=>{
  const {client}=await wire(t,(socket,c)=>{
    if(c.cmd!=="list_subscriptions")return false;
    socket.send(`{"id":${c.id},"type":"ok","msg":[{"channel":"trade","sid":9007199254740993}]}`);return true;
  },{reconnect:{maxAttempts:0}},product);
  await assert.rejects(client.listSubscriptions());await until(()=>client.state==="closed");
});

for(const scoped of [false,true])test(`a correctly correlated ${scoped?"scoped":"unscoped"} command error still rejects without invented mandatory SID`,{timeout:5000},async t=>{
  const {client}=await wire(t,(socket,c)=>{
    if(c.cmd!=="update_subscription")return false;
    socket.send(JSON.stringify({id:c.id,type:"error",...(scoped?{sid:c.params.sid,seq:1}:{}),msg:{code:7,msg:"source-declared error"}}));return true;
  });
  const handle=await client.subscribe("ticker",{market_tickers:["KXTEST-A"]});
  await assert.rejects(handle.update({action:"add_markets",market_tickers:["KXTEST-B"]}),error=>{
    assert.ok(error instanceof KalshiWebSocketCommandError);assert.equal(error.response.sid,scoped?handle.sid:undefined);return true;
  });
  assert.equal(client.state,"open");
});

for(const malformed of [false,true])test(`${malformed?"malformed JSON":"undeclared message type"} wire failure cannot leak raw frame contents in rejected command diagnostics`,{timeout:5000},async t=>{
  const secret="LEAKTOKEN";
  const {client}=await wire(t,(socket,c)=>{
    if(c.cmd!=="list_subscriptions")return false;
    socket.send(malformed?secret:JSON.stringify({type:secret,sid:1,msg:{}}));return true;
  },{reconnect:{maxAttempts:0}});
  await client.subscribe("trade");
  await assert.rejects(client.listSubscriptions(),error=>{
    for(const output of [String(error),inspect(error,{depth:20}),JSON.stringify(error)])assert.equal(output.includes(secret),false);
    return true;
  });
  await until(()=>client.state==="closed");
});

test("Volta matching command ID but wrong scoped-error SID cannot reject a target mutation",{timeout:5000},async t=>{
  let command:Schema|undefined;
  const {client,peers}=await wire(t,(_socket,c)=>{if(c.cmd==="update_subscription"){command=c;return true;}return false;});
  const target=await client.subscribe("ticker",{market_tickers:["KXTEST-A"]}), other=await client.subscribe("trade");
  let settled=false;const updating=target.update({action:"add_markets",market_tickers:["KXTEST-B"]});void updating.then(()=>{settled=true;},()=>{settled=true;});await until(()=>command!==undefined);
  const events=client.events();peers[0]!.send(JSON.stringify({id:command!.id,type:"error",sid:other.sid,seq:1,msg:{code:7,msg:"other subscription"}}));
  for(;;){const event=await events.next();if(event.value?.kind==="message"&&"type" in event.value.value&&event.value.value.type==="error")break;}
  assert.equal(settled,false);assert.equal(client.state,"open");
  peers[0]!.send(JSON.stringify({id:command!.id,type:"ok",sid:target.sid,seq:1,msg:{}}));assert.equal((await updating).sid,target.sid);
});

for(const product of ["predictions","perps"] as const)test(`${product} empty native Ping echoes exactly once without closing, with fresh Ed25519 reconnect signing`,{timeout:5000},async t=>{
  const {client,peers,stamps}=await wire(t,()=>false,{},product,"ed25519");await (client instanceof KalshiPredictionsWebSocketClient?client.subscribe("trade"):client.subscribe("trade"));
  let empty=0,heartbeat=0;peers[0]!.on("pong",data=>{if(data.length===0)empty++;else if(data.toString()==="heartbeat")heartbeat++;});
  peers[0]!.ping("");await until(()=>empty===1);assert.equal(client.state,"open");
  peers[0]!.ping("heartbeat");await until(()=>heartbeat===1);await client.ping();assert.equal(empty,1);
  peers[0]!.terminate();await until(()=>peers.length===2&&client.state==="open");assert.ok(Number(stamps[1])>Number(stamps[0]));
});
