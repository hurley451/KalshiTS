import assert from "node:assert/strict";
import { createServer } from "node:http";
import { constants, generateKeyPairSync, verify, createHash, sign } from "node:crypto";
import { once } from "node:events";

export async function runPerpsWireProof(sdk, data, source) {
  const records=[];
  let expected;
  let algorithm;
  let keys;
  let signed=false;
  let mode="normal";
  const wrongRsa=generateKeyPairSync("rsa",{modulusLength:2048}).publicKey;
  const wrongEd=generateKeyPairSync("ed25519").publicKey;
  const server=createServer(async(req,res)=>{
    const chunks=[];
    for await(const chunk of req) chunks.push(chunk);
    const body=Buffer.concat(chunks).toString();
    const url=new URL(req.url,"http://localhost");
    const record={method:req.method,path:url.pathname,query:[...url.searchParams],headers:req.headers,body};
    records.push(record);
    try {
      assert.equal(req.method,expected.method);
      assert.equal(url.pathname,"/trade-api/v2"+expected.path.replace(/\{([^}]+)}/g,(_,n)=>encodeURIComponent(String(expected.input.pathParameters[n]))));
      assert.equal(body,expected.input.body===undefined?"":JSON.stringify(expected.input.body));
      assert.equal(req.headers["x-proof"],"wire");
      const query=expected.input.query??{};
      const pairs=[];
      for(const p of expected.parameters.filter(p=>p.in==="query")) {
        const v=query[p.name];if(v===undefined) continue;
        if(Array.isArray(v)) for(const item of v) pairs.push([p.name,String(item)]);
        else pairs.push([p.name,String(v)]);
      }
      assert.deepEqual([...url.searchParams],pairs);
      if(signed) {
        assert.equal(req.headers["kalshi-access-key"],"wire-key");
        const timestamp=req.headers["kalshi-access-timestamp"];
        const signature=Buffer.from(req.headers["kalshi-access-signature"],"base64");
        const key=algorithm==="rsa"?{key:keys.publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:constants.RSA_PSS_SALTLEN_DIGEST}:keys.publicKey;
        const hash=algorithm==="rsa"?"sha256":null;
        const preimage=Buffer.from(timestamp+req.method+url.pathname);
        assert.equal(verify(hash,preimage,key,signature),true);
        for(const bad of [timestamp+"PATCH"+url.pathname,timestamp+req.method+"/wrong",timestamp+req.method+url.pathname+"?wrong=1"]) assert.equal(verify(hash,Buffer.from(bad),key,signature),false);
        if(algorithm==="ed25519") {
          assert.equal(verify(null,createHash("sha256").update(preimage).digest(),key,signature),false);
          const prehashed=sign(null,createHash("sha256").update(preimage).digest(),keys.privateKey);
          assert.equal(verify(null,preimage,key,prehashed),false);
          assert.equal(verify(null,preimage,wrongEd,signature),false);
        } else assert.equal(verify("sha256",preimage,{key:wrongRsa,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:constants.RSA_PSS_SALTLEN_DIGEST},signature),false);
      } else assert.equal(req.headers["kalshi-access-key"],undefined);
      if(mode==="disconnect") {req.socket.destroy();return;}
      if(mode==="read-failure") {res.writeHead(200,{"content-type":"application/json","content-length":"100000"});res.write("{");setTimeout(()=>res.destroy(),5);return;}
      const r=expected.response;
      res.writeHead(r.status,{"content-type":"application/json","x-source":"perps",...(r.status===429?{"retry-after":"0"}:{})});
      res.end(r.rawBody??(r.body===undefined?undefined:JSON.stringify(r.body)));
    } catch(error) { record.failure=error;res.writeHead(599);res.end(); }
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const base=`http://127.0.0.1:${server.address().port}/trade-api/v2`;
  const make=(options={})=>new sdk.KalshiPerpsClient({environment:{name:"loopback",restBaseUrl:base},...options});
  const invoke=(client,f,domain=false,input=f.input,options={headers:{"X-Proof":"wire"}})=> (domain?client[f.domain]:client)[f.methodName](input,options);
  const assertOracle=()=>{for(const r of records) if(r.failure) throw r.failure;};
  let bindings=0, signatures=0,publicCalls=0,mutationCases=0,malformedBindings=0;
  try {
    for(const f of data.fixtures) {
      const operation=source.paths[f.path][f.method.toLowerCase()];
      assert.equal(operation.operationId,f.operationId);
      expected={...f,response:f.responses.find(r=>r.status<300)};
      for(const r of f.responses) for(const domain of [false,true]) {
        expected.response=r;
        const before=records.length;
        const client=make();
        if(r.status<300) assert.deepEqual(await invoke(client,f,domain,f.input,{authenticated:false,headers:{"X-Proof":"wire"}}),r.body);
        else await assert.rejects(invoke(client,f,domain,f.input,{authenticated:false,headers:{"X-Proof":"wire"}}),error=>{
          assert(sdk.isPerpsEndpointError(error,f.operationId));
          assert.equal(sdk.isEndpointError(error,f.operationId),false);
          assert.equal(error.status,r.status);assert.deepEqual(error.body,r.body);
          assert.equal(error.headers.get("x-source"),"perps");
          assert.deepEqual(Buffer.from(error.rawBody),Buffer.from(r.body===undefined?"":JSON.stringify(r.body)));
          return true;
        });
        assert.equal(records.length,before+1);assertOracle();bindings++;
      }
      for(const r of f.responses) {
        const schema=operation.responses[String(r.status)].content?.["application/json"]?.schema;
        if(!schema) continue;
        expected.response={status:r.status,body:42};
        await assert.rejects(invoke(make(),f,false,f.input,{authenticated:false,headers:{"X-Proof":"wire"}}),error=>{
          assert(error instanceof (r.status<300?sdk.KalshiContractError:sdk.KalshiInvalidResponseError));
          if(r.status>=300) {assert.equal(error.status,r.status);assert.equal(Buffer.from(error.rawBody).toString(),"42");assert.equal(error.headers.get("x-source"),"perps");}
          return true;
        });assertOracle();malformedBindings++;
      }
      for(const a of ["rsa","ed25519"]) {
        algorithm=a;keys=a==="rsa"?generateKeyPairSync("rsa",{modulusLength:2048}):generateKeyPairSync("ed25519");signed=true;
        expected.response=f.responses.find(r=>r.status<300);
        const client=make({auth:{apiKeyId:"wire-key",privateKeyPem:keys.privateKey}});
        await invoke(client,f,a==="ed25519");assertOracle();signatures++;
      }
      signed=false;
      if((operation.security??source.security??[]).length===0) {await invoke(make(),f);assertOracle();publicCalls++;}
      if(f.method!=="GET") {
        for(const failure of ["status","disconnect","read-failure"]) {
          mode=failure==="status"?"normal":failure;
          expected.response={status:503,body:{message:"retryable"}};
          const before=records.length;
          await assert.rejects(invoke(make({retry:{maxAttempts:3,baseDelayMs:0}}),f,false,f.input,{authenticated:false,headers:{"X-Proof":"wire"}}));
          assert.equal(records.length,before+1);assertOracle();mutationCases++;
        }
        mode="normal";
      }
    }
    assert.equal(bindings,472);assert.equal(signatures,102);assert.equal(publicCalls,10);assert.equal(mutationCases,72);
    for(const op of ["GetMarginFills","GetMarginOrders","GetMarginTrades"]) {
      const f=data.fixtures.find(f=>f.operationId===op);
      const collection={GetMarginFills:"fills",GetMarginOrders:"orders",GetMarginTrades:"trades"}[op];
      const input=structuredClone(f.input);delete input.query.cursor;
      expected={...f,input,response:undefined};
      const before=records.length;
      let calls=0;
      const client=make({fetch:async(url,init)=>{
        const current=calls++;
        expected.input={...input,query:{...input.query,...(current?{cursor:`page-${current}`}:{})}};
        expected.response={status:200,body:{...f.responses.find(r=>r.status===200).body,cursor:current===2?"":`page-${current+1}`}};
        return fetch(url,init);
      }});
      const iterator=client[f.domain][f.methodName+"Pages"](input,{authenticated:false,headers:{"X-Proof":"wire"}},{maxPages:3});
      assert.equal(calls,0);
      const pages=[];for await(const page of iterator) {assert(page[collection].length>0);pages.push(page);}
      assert.equal(pages.length,3);assert.equal(records.length,before+3);assertOracle();
    }
    const f=data.fixtures.find(f=>f.operationId==="GetMarginExchangeStatus");expected={...f,response:{status:200,rawBody:Buffer.from([0xff,0xfe])}};
    await assert.rejects(invoke(make(),f),error=>error instanceof sdk.KalshiResponseParseError&&Buffer.from(error.rawBody).equals(Buffer.from([0xff,0xfe])));
    expected.response={status:418,rawBody:Buffer.from([0xff,0xfe])};
    await assert.rejects(invoke(make(),f),error=>error instanceof sdk.KalshiApiError&&error.status===418&&!sdk.isPerpsEndpointError(error,f.operationId)&&Buffer.from(error.rawBody).equals(Buffer.from([0xff,0xfe])));
    assertOracle();
    return {responseDispatches:bindings,malformedBindings,signedDispatches:signatures,unsignedPublic:publicCalls,mutationNoReplay:mutationCases,pagers:3};
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
