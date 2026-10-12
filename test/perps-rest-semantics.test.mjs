import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { sample } from "openapi-sampler";
import { requireCoreRoot } from "./helpers/core-root.mjs";

const sdkModule = process.env.PERPS_SEMANTIC_SDK_MODULE ?? path.join(process.cwd(),"dist/src/index.js");
const sdk = await import(sdkModule);
const { perpsContractComponents, perpsSourceComponents } = await import(path.join(path.dirname(sdkModule),"generated/perps-rest/contracts.js"));
const core = requireCoreRoot();
const sourcePath = path.join(core,"sources/perps/perps_openapi.yaml");
const sourceBytes = readFileSync(sourcePath);
const raw = YAML.parse(sourceBytes.toString());
const fixtures = JSON.parse(readFileSync("test/perps-rest/fixtures.json")).fixtures;
const gaps = JSON.parse(readFileSync("src/generated/perps-rest/source-gaps.json"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const at = pointer => pointer.slice(2).split("/").map(k=>k.replaceAll("~1","/").replaceAll("~0","~")).reduce((n,k)=>n[k],raw);
const resolve = schema => schema.$ref ? at(schema.$ref) : schema;
const operations = new Map();
for (const [route,item] of Object.entries(raw.paths)) for (const [verb,op] of Object.entries(item)) {
  if (op.operationId) operations.set(op.operationId,{route,verb,op});
}
function inputFor(id,body) {
  const {op} = operations.get(id);
  const input = {body};
  for (const p of (op.parameters??[]).map(resolve).filter(p=>p.in==="path")) (input.pathParameters??={})[p.name]=sample(p.schema,{},raw);
  return input;
}

// Independently reproduce the reviewer's 19 source-permitted, prose-invalid bodies.
const heldCases = {
  CreateMarginOrder:[{ticker:""},{market_id:"not-a-uuid"}],
  AmendMarginOrder:[{}, {ticker:""}, {market_id:"not-a-uuid"}],
  CreateMarginOrderGroup:[{}, {contracts_limit:1,contracts_limit_fp:"2.00"},{contracts_limit_fp:"1.50"}],
  UpdateMarginOrderGroupLimit:[{}, {contracts_limit:1,contracts_limit_fp:"2.00"},{contracts_limit_fp:"1.50"}],
  UpdateCrossMarginExitTrigger:[{}, {stop_loss_price:"0.0000"}],
  SetCrossMarginExitTrigger:[{}, {kind:"trailing",trail_amount:"1.0000",trail_bps:10},{kind:"bracket",stop_loss_price:"1.0000",count:"1.50",anchor_order_id:"anchor"}],
  SetIsolatedMarginExitTrigger:[{}, {kind:"trailing",trail_amount:"1.0000",trail_bps:10},{kind:"bracket",stop_loss_price:"0.0000"}]
};
const held = Object.entries(heldCases).flatMap(([id,bodies])=>{
  const schema = operations.get(id).op.requestBody.content["application/json"].schema;
  const base = sample(schema,{skipNonRequired:true},raw);
  delete base.ticker;delete base.market_id;
  return bodies.map(extra=>({id,input:inputFor(id,{...base,...extra})}));
});
const uuid = "00000000-0000-4000-8000-000000000001";
const createBase = {client_order_id:"semantic-order",side:"bid",count:"1.50",price:"1.0000",time_in_force:"good_till_canceled",self_trade_prevention_type:"maker"};
const amendBase = {side:"bid",count:"1.50",price:"1.0000",expiration_time:0};
const positive = [];
const add = (id,body) => positive.push({id,input:inputFor(id,body)});
for (const [id,base] of [["CreateMarginOrder",createBase],["AmendMarginOrder",amendBase]]) {
  for (const selector of [{ticker:"BTC"},{market_id:uuid},{ticker:"BTC",market_id:uuid},{ticker:"",market_id:uuid},{ticker:"BTC",market_id:""}]) add(id,{...base,...selector});
}
for (const time_in_force of ["immediate_or_cancel","fill_or_kill"]) add("CreateMarginOrder",{...createBase,ticker:"BTC",reduce_only:true,time_in_force,market_version:1});
for (const id of ["CreateMarginOrderGroup","UpdateMarginOrderGroupLimit"]) {
  for (const body of [{contracts_limit:1},{contracts_limit:1,contracts_limit_fp:null},
    ...["1","1.0","1.00","0001.00"].flatMap(fp=>[{contracts_limit_fp:fp},{contracts_limit:1,contracts_limit_fp:fp}]),
    {contracts_limit_fp:"9007199254740993.00"},
    {contracts_limit:Number.MAX_SAFE_INTEGER,contracts_limit_fp:"9007199254740991.00"}]) add(id,body);
}
const legCases = [{stop_loss_price:"1.0000"},{take_profit_price:"2.0000"},{stop_loss_price:"1.0000",take_profit_price:"2.0000"}];
for (const legs of legCases) {
  add("UpdateCrossMarginExitTrigger",legs);
  for (const id of ["SetCrossMarginExitTrigger","SetIsolatedMarginExitTrigger"]) {
    add(id,legs);add(id,{...legs,kind:"bracket"});
    if(id==="SetCrossMarginExitTrigger") {
      for(const count of ["0","1","1.0","1.00"]) add(id,{...legs,count,client_trigger_id:"partial"});
      add(id,{...legs,anchor_order_id:"anchor",client_trigger_id:"anchored"});
    }
  }
}
for (const id of ["SetCrossMarginExitTrigger","SetIsolatedMarginExitTrigger"]) for (const distance of [{trail_amount:"1.0000"},{trail_bps:1},{trail_bps:9999}]) {
  add(id,{kind:"trailing",...distance});
  if(id==="SetCrossMarginExitTrigger") add(id,{kind:"trailing",...distance,count:"1.00",client_trigger_id:"partial-trail"});
}
add("UpdateCrossMarginExitTrigger",{stop_loss_price:"0.0000000000000000001"});
for (const body of [{reduce_by:"1.50"},{reduce_to:"0.00"},{reduce_by:"1.50",reduce_to:null},{reduce_by:null,reduce_to:"0.00"}]) add("DecreaseMarginOrder",body);

const additionalNegative = [
  {id:"CreateMarginOrder",input:inputFor("CreateMarginOrder",createBase)},
  ...["CreateMarginOrder","AmendMarginOrder"].map(id=>({id,input:inputFor(id,{...(id==="CreateMarginOrder"?createBase:amendBase),ticker:"BTC",market_id:"invalid"})})),
  ...["CreateMarginOrderGroup","UpdateMarginOrderGroupLimit"].flatMap(id=>[
    {contracts_limit_fp:null},{contracts_limit_fp:"0.00"},{contracts_limit_fp:"-1.00"},{contracts_limit_fp:"1.000"},
    {contracts_limit:Number.MAX_SAFE_INTEGER,contracts_limit_fp:"9007199254740993.00"}
  ].map(body=>({id,input:inputFor(id,body)}))),
  ...["UpdateCrossMarginExitTrigger","SetCrossMarginExitTrigger","SetIsolatedMarginExitTrigger"].flatMap(id=>[
    {take_profit_price:"0.0000"},{stop_loss_price:"-1.0000"},{stop_loss_price:"not-a-price"},
    {stop_loss_price:"0.0000",take_profit_price:"1.0000"}
  ].map(body=>({id,input:inputFor(id,body)}))),
  ...["SetCrossMarginExitTrigger","SetIsolatedMarginExitTrigger"].flatMap(id=>[
    {kind:"trailing"},{kind:"bracket",trail_amount:"1.0000"},
    {kind:"trailing",trail_bps:1,stop_loss_price:"1.0000"},
    {kind:"bracket",stop_loss_price:"1.0000",trail_bps:1}
  ].map(body=>({id,input:inputFor(id,body)}))),
  ...[{stop_loss_price:"1.0000",count:"1.50",client_trigger_id:"partial"},
    {stop_loss_price:"1.0000",count:"1.00"},
    {stop_loss_price:"1.0000",anchor_order_id:"anchor"},
    {stop_loss_price:"1.0000",count:"1.00",anchor_order_id:"anchor",client_trigger_id:"both"},
    {kind:"trailing",trail_bps:1,anchor_order_id:"anchor",client_trigger_id:"anchor"},
    {stop_loss_price:"1.0000",client_trigger_id:"not-an-append"},
    {stop_loss_price:"1.0000",count:"1.00",client_trigger_id:""}
  ].map(body=>({id:"SetCrossMarginExitTrigger",input:inputFor("SetCrossMarginExitTrigger",body)}))
];

test("19 held source-prose negatives and additional semantic constraints send zero requests through named/domain clients",async()=>{
  assert.equal(held.length,19);
  assert.equal(additionalNegative.length,40);
  let fetches = 0,requests = 0;
  const server = createServer((req,res)=>{requests++;res.writeHead(400);res.end();});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try {
    const client = new sdk.KalshiPerpsClient({environment:{name:"semantics",restBaseUrl:`http://127.0.0.1:${server.address().port}/trade-api/v2`},fetch:async(...args)=>{fetches++;return fetch(...args);}});
    for(const {id,input} of held) sdk.validatePerpsSourceContract(id,"raw held",operations.get(id).op.requestBody.content["application/json"].schema,input.body);
    for(const {id,input} of [...held,...additionalNegative]) {
      const fixture=fixtures.find(f=>f.operationId===id);
      for(const target of [client,client[fixture.domain]]) await assert.rejects(target[fixture.methodName](input,{authenticated:false}),e=>e instanceof sdk.KalshiContractError&&e.operationId===`perps_openapi:${id}`);
    }
    assert.equal(fetches,0);assert.equal(requests,0);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test("all positive selector/limit/exit combinations and non-null decrease preserve exact caller bodies on real wire",async()=>{
  assert.equal(positive.length,80);
  let expected,requests=0,failure;
  const server=createServer(async(req,res)=>{
    try {
      const chunks=[];for await(const c of req) chunks.push(c);
      const body=JSON.parse(Buffer.concat(chunks).toString());
      assert.deepEqual(body,expected.input.body);
      const op=operations.get(expected.id);assert.equal(req.method,op.verb.toUpperCase());
      assert.equal(new URL(req.url,"http://localhost").pathname,"/trade-api/v2"+op.route.replace(/\{([^}]+)}/g,(_,key)=>encodeURIComponent(expected.input.pathParameters[key])));
      assert.equal(req.headers["x-semantic"],"positive");requests++;
      const response=fixtures.find(f=>f.operationId===expected.id).responses.find(r=>r.status<300);
      res.writeHead(response.status,{"content-type":"application/json"});res.end(JSON.stringify(response.body));
    } catch(error) {failure=error;res.writeHead(599);res.end();}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try {
    const c=new sdk.KalshiPerpsClient({environment:{name:"semantics",restBaseUrl:`http://127.0.0.1:${server.address().port}/trade-api/v2`}});
    for(const item of positive) {
      expected=item;const before=structuredClone(item.input);const fixture=fixtures.find(f=>f.operationId===item.id);
      for(const target of [c,c[fixture.domain]]) await target[fixture.methodName](item.input,{authenticated:false,headers:{"X-Semantic":"positive"}});
      assert.deepEqual(item.input,before);if(failure) throw failure;
      const schema=operations.get(item.id).op.requestBody.content["application/json"].schema;
      sdk.validatePerpsContract(item.id,"positive model",schema,item.input.body);
    }
    assert.equal(requests,positive.length*2);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test("raw source/types remain exact; derived semantics have source-qualified preconditions and October 12 boundaries",()=>{
  assert.equal(hash(sourceBytes),"27e4b0b76a686f797342f1526a08df5b8f60d8104a81b65c94073d3d89b54308");
  assert.deepEqual(perpsSourceComponents,raw.components);
  assert.deepEqual(readFileSync("src/generated/perps-rest/source-schema.ts"),execFileSync("git",["show","HEAD:src/generated/perps-rest/source-schema.ts"]));
  const names=["CreateMarginOrderRequest","AmendMarginOrderRequest","DecreaseMarginOrderRequest","CreateOrderGroupRequest","UpdateOrderGroupLimitRequest","UpdateExitTriggerRequest","SetCrossExitTriggerRequest","SetIsolatedExitTriggerRequest"];
  assert.deepEqual(gaps.refinements.map(r=>r.identity.pointer.split("/").at(-1)).sort(),names.sort());
  for(const r of gaps.refinements) {
    assert.equal(r.identity.sourceId,"perps_openapi");assert.deepEqual(r.precondition,at(r.identity.pointer));
    assert.equal(r.preconditionHash,hash(JSON.stringify(r.precondition)));assert.equal(r.sourceHash,hash(sourceBytes));assert.equal(r.activeDate,"2026-10-12");assert(r.affectedOperations.length);
  }
  const expected=structuredClone(raw.components);
  for(const field of ["funding_deadband","funding_cap","funding_limit_unit","bid_size_fp","ask_size_fp"]) {delete expected.schemas.MarginMarket.properties[field];expected.schemas.MarginMarket.required=expected.schemas.MarginMarket.required.filter(k=>k!==field);}
  for(const field of ["leverage_estimate","leverage_estimates"]) expected.schemas.MarginMarket.properties[field].nullable=true;
  delete expected.schemas.IntraExchangeInstanceTransferRequest.properties.client_transfer_id;
  const actual=structuredClone(perpsContractComponents);
  for(const name of names) actual.schemas[name]=raw.components.schemas[name];
  assert.deepEqual(actual,expected);
  assert(actual.schemas.ApplySubaccountTransferRequest.required.includes("client_transfer_id"));
  assert(actual.schemas.CreateMarginOrderRequest.properties.market_version);
  assert(actual.schemas.AmendMarginOrderRequest.properties.expiration_time);
  assert.deepEqual(readFileSync(sourcePath),sourceBytes);
});

test("strict declarations accept positive combinations and reject representable missing/conflicting request shapes",()=>{
  const root=mkdtempSync(path.join(tmpdir(),"perps-semantic-types-"));
  try {
    const source=[`import type {KalshiPerpsClient} from ${JSON.stringify(sdkModule)};`,`declare const c:KalshiPerpsClient;`];
    for(const {id,input} of positive) source.push(`c.${fixtures.find(f=>f.operationId===id).methodName}(${JSON.stringify(input)});`);
    const ids=["CreateMarginOrder","AmendMarginOrder","CreateMarginOrderGroup","UpdateMarginOrderGroupLimit","UpdateCrossMarginExitTrigger","SetCrossMarginExitTrigger","SetIsolatedMarginExitTrigger"];
    for(const id of ids) {
      const body=id==="CreateMarginOrder"?createBase:id==="AmendMarginOrder"?amendBase:{};
      source.push(`// @ts-expect-error source-prose required member`,`c.${fixtures.find(f=>f.operationId===id).methodName}(${JSON.stringify(inputFor(id,body))});`);
    }
    for(const id of ["SetCrossMarginExitTrigger","SetIsolatedMarginExitTrigger"]) source.push(`// @ts-expect-error mutually exclusive trailing distances`,`c.${fixtures.find(f=>f.operationId===id).methodName}(${JSON.stringify(inputFor(id,{kind:"trailing",trail_amount:"1.0000",trail_bps:1}))});`);
    const file=path.join(root,"consumer.mts");writeFileSync(file,source.join("\n"));
    const args=["node_modules/typescript/lib/tsc.js","--strict","--exactOptionalPropertyTypes","--noEmit","--module","NodeNext","--moduleResolution","NodeNext","--target","ES2022","--typeRoots",path.join(process.cwd(),"node_modules/@types"),file];
    const result=spawnSync(process.execPath,args,{encoding:"utf8"});assert.equal(result.status,0,result.stdout+result.stderr);
  } finally {rmSync(root,{recursive:true,force:true});}
});

if (!process.env.PERPS_SEMANTIC_INSTALLED_PASS) test("installed tarball repeats all semantic negatives/positives, declarations and raw-source proofs",()=>{
  const root=mkdtempSync(path.join(tmpdir(),"perps-semantic-installed-"));
  const env={...process.env,npm_config_cache:path.join(root,"npm-cache")};
  const run=(command,args,cwd=root)=>execFileSync(command,args,{cwd,env,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  try {
    const output=run("npm",["pack","--ignore-scripts","--json","--pack-destination",root],process.cwd());
    const pack=JSON.parse(output.slice(output.indexOf("[")))[0];
    assert(pack.files.some(f=>f.path==="dist/src/perps-contracts.js"));
    assert(pack.files.some(f=>f.path==="src/generated/perps-rest/source-gaps.json"));
    writeFileSync(path.join(root,"package.json"),JSON.stringify({private:true,type:"module"}));
    run("npm",["install","--ignore-scripts","--no-audit","--no-fund",path.join(root,pack.filename)]);
    const installed=path.join(root,"node_modules/@hurley451/kalshi-ts");
    const ledger=JSON.parse(readFileSync(path.join(installed,"src/generated/perps-rest/source-gaps.json")));
    assert.deepEqual(ledger.refinements,gaps.refinements);
    const consumerEnv={...env,PERPS_SEMANTIC_INSTALLED_PASS:"1",PERPS_SEMANTIC_SDK_MODULE:path.join(installed,"dist/src/index.js")};
    delete consumerEnv.NODE_TEST_CONTEXT;
    const result=spawnSync(process.execPath,["--test","--test-reporter=tap","test/perps-rest-semantics.test.mjs"],{
      cwd:process.cwd(),encoding:"utf8",env:consumerEnv
    });
    assert.equal(result.status,0,result.stdout+result.stderr);
    assert.match(result.stdout,/# pass 5/);assert.match(result.stdout,/# fail 0/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("semantic source/precondition drift fails portable generation; raw input and raw type output remain unchanged",()=>{
  const root=mkdtempSync(path.join(tmpdir(),"perps-semantic-source-"));
  try {
    for(const file of ["sources/perps/perps_openapi.yaml","sources/perps/perps_openapi-source.json","sources/perps/perps_openapi-inventory.json","contracts/perps_openapi.json"]) {mkdirSync(path.dirname(path.join(root,file)),{recursive:true});cpSync(path.join(core,file),path.join(root,file));}
    for(const rule of gaps.refinements) {
      const changed=structuredClone(raw);const name=rule.identity.pointer.split("/").at(-1);
      changed.components.schemas[name].description="changed semantic source";
      writeFileSync(path.join(root,"sources/perps/perps_openapi.yaml"),YAML.stringify(changed));
      const result=spawnSync(process.execPath,["scripts/generate-client.mjs","--product","perps","--kalshicore-root",root,"--active-date","2026-10-12","--out-dir",path.join(root,"outputs")],{encoding:"utf8"});
      assert.notEqual(result.status,0);assert.match(result.stderr,/Unreviewed Perps source digest/);
    }
    assert.deepEqual(readFileSync(sourcePath),sourceBytes);
  } finally {rmSync(root,{recursive:true,force:true});}
});
